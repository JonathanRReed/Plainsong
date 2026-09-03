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
//! This file used to hold ~38k lines of handler bodies. The split below is
//! move-only: nothing was renamed, and `lib.rs` re-exports each module so every
//! existing call site and test path still resolves through the crate root.
//!
//! | module | what lives there |
//! | --- | --- |
//! | `dispatch` | `dispatch_command` and its match over every JSON-RPC method |
//! | `analysis` | meeting analysis passes, grounded summary/action items, relationship memory |
//! | `dictation_text` | dictation transcript sanitising, mode/prompt resolution, snippet and command text |
//! | `text_insert` | the macOS accessibility, clipboard and keystroke path that puts text at the cursor |
//! | `asr_routing` | provider/model selection and fallback for the meeting and dictation lanes |
//! | `streaming_partials` | live-preview partial decoding, VAD-aligned chunk cuts, streaming events |
//! | `recording_vault` | recording-audio encryption, vault key migration, runtime playback staging |
//! | `retention` | dictation and meeting retention policies, meeting auto-naming |
//! | `model_cache` | on-disk model artifact validation and cache repair |
//! | `audio_import_runtime` | `import_audio_file` and its `afconvert` staging |
//! | `meeting_pipeline` | the post-stop meeting transcription pipeline |
//!
//! What stays here: the crate docs, the module declarations, `AppState` and the
//! other shared types, the sidecar lifecycle entry points (`build_app_state`,
//! `start_dictation_for_sidecar`, `stop_dictation_for_sidecar`,
//! `start_recording_for_sidecar`, `stop_recording_for_sidecar`, settings and
//! permission handling), and the re-exports that keep the seam invisible to
//! callers.

pub mod admission;
mod analysis;
mod approved_locations;
pub mod asr;
mod asr_routing;
mod audio;
mod audio_import;
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
pub mod dictation_secure_field;
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
mod meeting_transcribe;
mod model_cache;
mod models;
mod operation_coordinator;
mod ort_utils;
mod paths;
mod playback;
mod recording_audio;
pub mod recording_pause;
mod recording_vault;
mod remote_processing;
mod retention;
mod safe_fs;
mod secrets;
pub mod settings;
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
pub use recording_vault::sweep_runtime_playback_audio_for_sidecar;

// Glob re-exports of the modules lib.rs was split into, so every call site left
// here resolves the moved items by their old unqualified names. Nothing was
// renamed; the modules are the only thing that is new.
pub(crate) use analysis::*;
pub(crate) use asr_routing::*;
pub(crate) use dictation_commands::*;
pub(crate) use dictation_live_preview::*;
pub(crate) use dictation_text::*;
pub(crate) use export_paths::*;
pub(crate) use meeting_transcribe::*;
pub(crate) use model_cache::*;
pub(crate) use recording_vault::*;
pub(crate) use retention::*;
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

fn validate_shortcut_settings(shortcuts: &settings::KeyboardShortcuts) -> Result<(), String> {
    settings::validate_dictation_bindings(&shortcuts.dictation_bindings)
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async fn request_dictation_permissions_impl(
    state: &AppState,
) -> Result<PermissionDiagnostics, String> {
    let mut notes = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Err(error) = ensure_microphone_permission(true) {
            notes.push(format!("Microphone permission request result: {}", error));
        }

        let apple_speech_selected = {
            let settings = state.settings_manager.lock().await.settings().clone();
            resolve_transcription_provider_and_model(
                &settings.transcription,
                TranscriptionScope::Dictation,
            )
            .0 == asr::AsrProviderType::MacosAppleSpeech
        };
        if apple_speech_selected {
            if let Err(error) = crate::asr::platform::macos_speech::ensure_speech_authorized(true) {
                notes.push(format!(
                    "Speech recognition permission request result: {}",
                    error
                ));
            }
        }

        if !request_accessibility_permission() {
            notes.push(
                "Accessibility permission is still not granted for this app copy. macOS may require you to re-enable Plainsong under Privacy & Security > Accessibility after app updates."
                    .to_string(),
            );
        }

        if !request_post_event_access() {
            notes.push(
                "macOS native keyboard-event access is still not granted for this app copy. Plainsong may need direct Accessibility text insertion instead."
                    .to_string(),
            );
        }
    }

    crate::asr::platform::macos_speech::invalidate_readiness_cache();
    state.asr_manager.invalidate_provider_info_cache().await;
    Ok(collect_permission_diagnostics(state, notes).await)
}

async fn request_apple_speech_permission_impl(
    state: &AppState,
) -> Result<PermissionDiagnostics, String> {
    let mut notes = Vec::new();

    #[cfg(target_os = "macos")]
    if let Err(error) = crate::asr::platform::macos_speech::ensure_speech_authorized(true) {
        notes.push(format!(
            "Speech recognition permission request result: {}",
            error
        ));
    }

    #[cfg(not(target_os = "macos"))]
    notes.push("Apple Speech permission is available on macOS only.".to_string());

    crate::asr::platform::macos_speech::invalidate_readiness_cache();
    state.asr_manager.invalidate_provider_info_cache().await;
    Ok(collect_permission_diagnostics(state, notes).await)
}

/// What the Models screen gets back after asking macOS for a language.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppleSpeechLanguageInstallResult {
    install: Option<crate::asr::platform::macos_speech::AppleSpeechAssetInstall>,
    readiness: crate::asr::platform::macos_speech::AppleSpeechReadiness,
    notes: Vec<String>,
}

/// What to tell the reader when a language install ended without installing.
///
/// Stopping on purpose is not a failure: reporting it as one puts a serialized
/// error payload in front of somebody who pressed Cancel and already knows
/// what happened. Everything else keeps the underlying error, which carries
/// the code and details the Models screen needs to say what to do next.
fn apple_speech_install_note(error: &anyhow::Error) -> String {
    if crate::asr::platform::macos_speech::typed_error_code(error).as_deref() == Some("cancelled") {
        return "Language install stopped.".to_string();
    }
    format!("Apple Speech language install failed: {}", error)
}

/// Installs the SpeechAnalyzer assets for one language.
///
/// This is the only place in the app that starts an Apple language download,
/// and it only runs when the reader asks for it. Progress is emitted as it
/// arrives rather than buffered, because the download is the OS's and can take
/// minutes.
async fn install_apple_speech_language_impl(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    locale: Option<&str>,
) -> Result<AppleSpeechLanguageInstallResult, String> {
    let mut notes = Vec::new();
    let install =
        match crate::asr::platform::macos_speech::install_language_assets(locale, |progress| {
            handle.emit_event(
                "apple-speech-language-install-progress",
                serde_json::json!({
                    "stage": progress.stage,
                    "locale": progress.locale,
                    "fraction": progress.fraction,
                    "message": progress.message,
                }),
            );
        })
        .await
        {
            Ok(install) => Some(install),
            Err(error) => {
                notes.push(apple_speech_install_note(&error));
                None
            }
        };

    crate::asr::platform::macos_speech::invalidate_readiness_cache();
    state.asr_manager.invalidate_provider_info_cache().await;
    Ok(AppleSpeechLanguageInstallResult {
        install,
        readiness: crate::asr::platform::macos_speech::fresh_readiness(),
        notes,
    })
}

async fn repair_cursor_insert_permissions_impl(
    state: &AppState,
) -> Result<PermissionDiagnostics, String> {
    let mut notes = Vec::new();

    #[cfg(target_os = "macos")]
    {
        state
            .accessibility_trust_observed
            .store(false, Ordering::Relaxed);

        match reset_tcc_service("Accessibility", APP_BUNDLE_IDENTIFIER) {
            Ok(()) => notes.push(
                "Reset the macOS Accessibility privacy decision for Plainsong. Re-enable Plainsong in Privacy & Security > Accessibility if macOS shows it turned off."
                    .to_string(),
            ),
            Err(error) => notes.push(format!(
                "Could not reset the macOS Accessibility privacy decision automatically: {}",
                error
            )),
        }

        if !request_accessibility_permission() {
            notes.push(
                "macOS still has not granted Accessibility to this Plainsong app copy. Turn Plainsong back on in Privacy & Security > Accessibility, then re-check readiness."
                    .to_string(),
            );
        }

        if let Err(error) = open_permission_settings_impl("accessibility") {
            notes.push(format!(
                "Could not open macOS Accessibility settings automatically: {}",
                error
            ));
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        notes.push("Cursor insert permission repair is supported on macOS only.".to_string());
    }

    Ok(collect_permission_diagnostics(state, notes).await)
}

fn microphone_setup_ready(input_present: bool, permission_granted: bool) -> bool {
    input_present && permission_granted
}

async fn collect_permission_diagnostics(
    state: &AppState,
    mut notes: Vec<String>,
) -> PermissionDiagnostics {
    let microphone_input_present = {
        let audio = state.audio_capture.lock().await;
        audio.has_microphone_input()
    };

    #[cfg(target_os = "macos")]
    let microphone_permission_ready = check_microphone_permission();

    #[cfg(not(target_os = "macos"))]
    let microphone_permission_ready = microphone_input_present;

    let microphone_ready =
        microphone_setup_ready(microphone_input_present, microphone_permission_ready);

    if !microphone_input_present {
        notes.push("No microphone input device is currently available.".to_string());
    }

    if !microphone_permission_ready {
        notes.push(
            "Microphone permission not granted yet. Enable Plainsong in Privacy & Security > Microphone."
                .to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    let app_bundle_path = current_app_bundle_path().map(|path| path.to_string_lossy().to_string());

    #[cfg(not(target_os = "macos"))]
    let app_bundle_path: Option<String> = None;

    #[cfg(target_os = "macos")]
    let recommended_app_bundle_path =
        installed_nautilus_app_bundle_path().map(|path| path.to_string_lossy().to_string());

    #[cfg(not(target_os = "macos"))]
    let recommended_app_bundle_path: Option<String> = None;

    #[cfg(target_os = "macos")]
    let running_from_disk_image = is_running_from_disk_image();

    #[cfg(not(target_os = "macos"))]
    let running_from_disk_image = false;

    #[cfg(target_os = "macos")]
    if running_from_disk_image {
        let running_path = app_bundle_path
            .as_deref()
            .unwrap_or("/Volumes/.../Plainsong.app");
        if let Some(installed_path) = recommended_app_bundle_path.as_deref() {
            notes.push(format!(
                "Plainsong is running from the mounted disk image at {}. macOS permissions granted to {} do not apply to this copy. Quit this DMG copy and open the installed app instead.",
                running_path, installed_path
            ));
        } else {
            notes.push(format!(
                "Plainsong is running from the mounted disk image at {}. Copy Plainsong.app into /Applications and open that installed copy so macOS permissions apply consistently.",
                running_path
            ));
        }
    }

    #[cfg(target_os = "macos")]
    let speech_recognition_ready = {
        let readiness = crate::asr::platform::macos_speech::readiness();
        let permission_ready = readiness.authorization == "authorized";
        if !readiness.ready {
            notes.push(readiness.message);
            if let Some(action) = readiness.setup_action {
                notes.push(action);
            }
        }
        permission_ready
    };

    #[cfg(not(target_os = "macos"))]
    let speech_recognition_ready = false;

    #[cfg(target_os = "macos")]
    let (
        accessibility_ready,
        accessibility_trusted,
        post_event_ready,
        automation_ready,
        cursor_insertion_ready,
        cursor_insertion_observed,
        preferred_insert_strategy,
        available_insert_strategies,
        last_cursor_insert_status,
    ) = {
        let last_cursor_insert_status = state
            .last_cursor_insert_status
            .lock()
            .ok()
            .and_then(|status| status.clone());
        let accessibility_probe_ready = check_accessibility_permission();
        let post_event_ready = check_post_event_access();
        let cursor_insertion_observed = state.accessibility_trust_observed.load(Ordering::Relaxed);
        let accessibility_trusted = accessibility_probe_ready || cursor_insertion_observed;
        if !accessibility_probe_ready && accessibility_trusted {
            notes.push(
                "Direct Accessibility insertion was verified by Plainsong in this session. The macOS permission probe may be stale for this app copy."
                    .to_string(),
            );
        }
        if let Some(status) = last_cursor_insert_status.as_ref() {
            if status.copied_only {
                let detail = status
                    .message
                    .as_deref()
                    .unwrap_or("Plainsong copied the dictation result but could not post Cmd+V.");
                notes.push(format!(
                    "Latest cursor insert attempt fell back to clipboard-only. {}",
                    detail
                ));
            }
        }
        let automation_ready = false;

        let mut available_insert_strategies = Vec::new();
        if accessibility_trusted {
            available_insert_strategies.push(CursorInsertStrategy::AccessibilityDirectText);
        }
        if accessibility_trusted || post_event_ready {
            available_insert_strategies.push(CursorInsertStrategy::SimulatedTyping);
        }
        let preferred_insert_strategy = available_insert_strategies.first().copied();
        let cursor_insertion_ready = !available_insert_strategies.is_empty();
        let accessibility_ready = accessibility_trusted;
        if !cursor_insertion_ready {
            if running_from_disk_image {
                notes.push(
                    "Cursor insertion is being checked for the currently running DMG copy, not the installed /Applications copy."
                        .to_string(),
                );
            } else {
                notes.push(
                    "Cursor insertion is not ready yet. Enable Plainsong in Privacy & Security > Accessibility so it can insert text into other apps."
                        .to_string(),
                );
            }
        } else if !accessibility_ready && post_event_ready {
            notes.push(
                "Cursor insertion can still work through a native macOS Cmd+V keyboard fallback even though direct Accessibility text insertion is not currently verified."
                    .to_string(),
            );
        }

        (
            accessibility_ready,
            accessibility_trusted,
            post_event_ready,
            automation_ready,
            cursor_insertion_ready,
            cursor_insertion_observed,
            preferred_insert_strategy,
            available_insert_strategies,
            last_cursor_insert_status,
        )
    };

    #[cfg(not(target_os = "macos"))]
    let (
        accessibility_ready,
        accessibility_trusted,
        post_event_ready,
        automation_ready,
        cursor_insertion_ready,
        cursor_insertion_observed,
        preferred_insert_strategy,
        available_insert_strategies,
        last_cursor_insert_status,
    ) = {
        notes.push(
            "Accessibility and automation probes are implemented for macOS first.".to_string(),
        );
        (
            false,
            false,
            false,
            false,
            false,
            false,
            None,
            Vec::new(),
            None,
        )
    };

    PermissionDiagnostics {
        microphone_ready,
        microphone_permission_ready,
        speech_recognition_ready,
        accessibility_ready,
        accessibility_trusted,
        post_event_ready,
        automation_ready,
        cursor_insertion_ready,
        cursor_insertion_observed,
        preferred_insert_strategy,
        available_insert_strategies,
        last_cursor_insert_status,
        running_from_disk_image,
        app_bundle_path,
        recommended_app_bundle_path,
        notes,
    }
}

fn open_permission_settings_impl(section: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let target = match section {
            "microphone" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
            "speech" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition"
            }
            "accessibility" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "automation" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
            }
            "system_audio" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        };

        let status = std::process::Command::new("open")
            .arg(target)
            .status()
            .map_err(|e| format!("Failed to open System Settings: {}", e))?;
        if !status.success() {
            return Err("Failed to open System Settings".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = section;
        Err("Permission settings shortcut is supported on macOS only.".to_string())
    }
}

fn open_installed_nautilus_app_impl() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app_path = installed_nautilus_app_bundle_path()
            .ok_or_else(|| "Installed Plainsong.app was not found in /Applications.".to_string())?;

        let status = std::process::Command::new("open")
            .arg(app_path)
            .status()
            .map_err(|e| format!("Failed to open installed Plainsong.app: {}", e))?;

        if !status.success() {
            return Err("Failed to open installed Plainsong.app".to_string());
        }

        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Opening the installed Plainsong app is supported on macOS only.".to_string())
    }
}

// Diarization commands

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DiarizationModelOption {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    installed: bool,
}

fn list_diarization_models() -> Vec<DiarizationModelOption> {
    #[allow(unused_mut)]
    let mut models = vec![
        DiarizationModelOption {
            id: "ecapa_tdnn_speaker",
            label: diarization::model_label("ecapa_tdnn_speaker"),
            description: "Fast and accurate, recommended for most use cases (~25 MB)",
            installed: diarization::is_model_available("ecapa_tdnn_speaker"),
        },
        DiarizationModelOption {
            id: "resnet34_speaker",
            label: diarization::model_label("resnet34_speaker"),
            description: "Balanced performance, good accuracy with moderate speed (~30 MB)",
            installed: diarization::is_model_available("resnet34_speaker"),
        },
        DiarizationModelOption {
            id: "campplus_speaker",
            label: diarization::model_label("campplus_speaker"),
            description: "Highest accuracy, best for challenging audio conditions (~35 MB)",
            installed: diarization::is_model_available("campplus_speaker"),
        },
        DiarizationModelOption {
            id: "eres2netv2_speaker",
            label: diarization::model_label("eres2netv2_speaker"),
            description: "Modern int8-quantized embedder, 192-dim, compact (~28 MB)",
            installed: diarization::is_model_available("eres2netv2_speaker"),
        },
    ];

    // Only offered when the backend is compiled in, so the picker never lists
    // a model this build has no code to run. The label says "experimental"
    // because it is: no shipped build enables it, and Plainsong has no DER
    // number of its own for either backend yet.
    #[cfg(feature = "diarization-speakrs")]
    models.push(DiarizationModelOption {
        id: download::SPEAKRS_MODEL_ID,
        label: diarization::model_label(download::SPEAKRS_MODEL_ID),
        description: SPEAKRS_PICKER_DESCRIPTION,
        installed: diarization::is_model_available(download::SPEAKRS_MODEL_ID),
    });

    models
}

/// What the picker says about the experimental speakrs entry, shown in the
/// option itself and therefore before anything is downloaded.
///
/// The licensing sentence is here rather than only in a Rust doc comment and a
/// QA receipt: the person who needs to know that these weights are mirrored
/// without a declared license is the one deciding whether to fetch them.
#[cfg(feature = "diarization-speakrs")]
const SPEAKRS_PICKER_DESCRIPTION: &str = concat!(
    "Full pyannote pipeline with overlap handling, via speakrs. Slower than ",
    "the embedding models and unmeasured on your audio (~60 MB, ten files). ",
    "Model weights mirrored without a declared license; upstream terms are ",
    "CC-BY-4.0 and gated. Not offered in shipped builds until resolved."
);

#[allow(non_snake_case)]
fn is_diarization_model_available(modelId: Option<String>) -> bool {
    let id = modelId
        .as_deref()
        .unwrap_or(diarization::DEFAULT_EMBEDDING_MODEL_ID);
    // An id this build does not offer is not "available": a run would silently
    // load ECAPA-TDNN for it, but telling the UI "yes, you have that model"
    // about a model that does not exist is a different claim. Ids that *are*
    // offered delegate, so the picker's badge, this probe and the gate on the
    // automatic pass give one answer instead of three.
    if !list_diarization_models().iter().any(|model| model.id == id) {
        return false;
    }
    diarization::is_model_available(id)
}

async fn smoke_test_cursor_insert_impl(
    state: &AppState,
    text: Option<String>,
) -> Result<serde_json::Value, String> {
    let sample = text
        .unwrap_or_else(|| "Plainsong cursor insert smoke test".to_string())
        .trim()
        .to_string();
    if sample.is_empty() {
        return Err("Smoke test text cannot be empty".to_string());
    }

    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };

    #[cfg(not(target_os = "macos"))]
    let target = (get_frontmost_app_name(), None);

    let outcome = paste_text_systemwide(
        &state.accessibility_trust_observed,
        &sample,
        true,
        target.0.as_deref(),
        target.1.as_deref(),
    );

    Ok(serde_json::json!({
        "text": sample,
        "targetApp": target.0,
        "targetBundleId": target.1,
        "pasted": outcome.pasted,
        "copied": outcome.copied,
        "error": outcome.error,
    }))
}

async fn capture_selected_text_for_playback_impl() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };

    #[cfg(target_os = "windows")]
    let target = (get_frontmost_app_name(), None);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        capture_selected_text_via_clipboard(target.0.as_deref())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Selected text playback is only supported on macOS and Windows.".to_string())
    }
}

async fn open_recording_audio_impl(state: &AppState, recording_id: &str) -> Result<(), String> {
    let runtime_audio_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::RuntimeAudio)?;
    let recording = {
        let db = state.db.lock().await;
        db.get_recording(recording_id)
            .map_err(|e| e.to_string())?
            .ok_or("Recording not found")?
    };

    if recording.audio_path.trim().is_empty() {
        return Err("Recording has no audio file path".to_string());
    }

    let resolved = resolve_recording_audio_bundle_for_runtime(state, recording_id).await?;
    open_path_in_default_app(&resolved.primary)?;
    schedule_recording_audio_bundle_cleanup(
        resolved,
        Duration::from_secs(120),
        runtime_audio_lease,
    );

    let mut db = state.db.lock().await;
    let details = serde_json::json!({
        "recording_id": recording_id,
        "audio_path": recording.audio_path,
    });
    if let Err(e) = db.log_audit_event("recording_audio_opened", Some(details), "info") {
        tracing::warn!("Failed to log audit event: {}", e);
    }

    Ok(())
}

fn open_export_path_impl(target_path: &str) -> Result<(), String> {
    let canonical = canonicalize_existing_absolute_path(target_path, "targetPath")?;
    if !canonical.is_file() {
        return Err(format!(
            "targetPath must point to a file, got: {}",
            canonical.display()
        ));
    }
    ensure_path_in_approved_roots(&canonical, "targetPath")?;
    open_path_in_default_app(&canonical)
}

async fn list_ollama_cloud_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("ollama-cloud")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();

    if secret.is_empty() {
        tracing::warn!("list_ollama_cloud_models called but secret is empty");
        return Ok(vec![]);
    } else {
        tracing::debug!(
            "list_ollama_cloud_models: secret present (len: {})",
            secret.len()
        );
    }

    let client = llm::OllamaCloudClient::with_api_key(Some(secret));

    // Log intent
    tracing::info!("Fetching Ollama Cloud models...");

    match client.list_models().await {
        Ok(models) => {
            tracing::info!("Ollama Cloud returned {} models", models.len());
            Ok(models)
        }
        Err(e) => {
            tracing::warn!("Ollama Cloud list_models failed: {}", e);
            Err(e.to_string())
        }
    }
}

fn provider_secret_or_env(secret_name: &str, env_name: &str) -> Result<String, String> {
    let secret = secrets::get_provider_secret(secret_name)
        .map_err(|e| e.to_string())?
        .or_else(|| std::env::var(env_name).ok())
        .unwrap_or_default();
    Ok(secret)
}

async fn list_openai_models() -> Result<Vec<String>, String> {
    let secret = provider_secret_or_env("openai", "OPENAI_API_KEY")?;

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::OpenAIClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

async fn list_openai_asr_models() -> Result<Vec<String>, String> {
    let secret = provider_secret_or_env("openai", "OPENAI_API_KEY")?;

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::OpenAIClient::with_api_key(Some(secret));
    let mut models: Vec<String> = client
        .list_all_models()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|id| {
            id.contains("whisper")
                || id.contains("transcribe")
                || id.contains("gpt-4o-mini-transcribe")
                || id.contains("gpt-4o-transcribe")
        })
        .collect();

    if models.is_empty() {
        models = vec![
            "whisper-1".to_string(),
            "gpt-4o-mini-transcribe".to_string(),
            "gpt-4o-transcribe".to_string(),
        ];
    }

    models.sort();
    models.dedup();
    Ok(models)
}

#[derive(Debug, serde::Deserialize)]
struct ElevenLabsAsrModel {
    model_id: String,
}

#[derive(Debug, serde::Deserialize)]
struct ElevenLabsAsrModelsResponse {
    models: Vec<ElevenLabsAsrModel>,
}

async fn list_elevenlabs_asr_models() -> Result<Vec<String>, String> {
    let secret = secrets::get_provider_secret("elevenlabs")
        .map_err(|e| e.to_string())?
        .or_else(|| std::env::var("ELEVENLABS_API_KEY").ok())
        .unwrap_or_default();

    if secret.trim().is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::new();
    let response = client
        .get("https://api.elevenlabs.io/v1/speech-to-text/models")
        .header("xi-api-key", secret)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Ok(vec!["scribe_v2".to_string()]);
    }

    let parsed: ElevenLabsAsrModelsResponse =
        llm::transport::read_json_body(response, llm::transport::MODEL_LIST_BODY_LIMIT)
            .await
            .map_err(|e| e.to_string())?;

    let mut models: Vec<String> = parsed
        .models
        .into_iter()
        .filter(|entry| entry.model_id != "scribe_v2_realtime")
        .map(|entry| entry.model_id)
        .collect();
    if models.is_empty() {
        models.push("scribe_v2".to_string());
    }
    models.sort();
    models.dedup();
    Ok(models)
}

async fn list_anthropic_models() -> Result<Vec<String>, String> {
    let secret = provider_secret_or_env("anthropic", "ANTHROPIC_API_KEY")?;

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::AnthropicClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

async fn list_gemini_models() -> Result<Vec<String>, String> {
    let secret = provider_secret_or_env("gemini", "GEMINI_API_KEY")?;

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::GeminiClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
}

async fn list_deepseek_models() -> Result<Vec<String>, String> {
    let secret = provider_secret_or_env("deepseek", "DEEPSEEK_API_KEY")?;

    if secret.is_empty() {
        return Ok(vec![]);
    }

    let client = llm::DeepSeekClient::with_api_key(Some(secret));
    client.list_models().await.map_err(|e| e.to_string())
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
            "This dictation mode prefers {} routing. Using '{}' / '{}' instead of '{}' / '{}'.",
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
        "This dictation mode prefers {} routing, but no {} dictation route is ready. Open Settings -> Setup and prepare one.",
        dictation_route_preference_to_settings_value(route_preference),
        dictation_route_preference_to_settings_value(route_preference)
    ))
}

async fn tracker_insertion_mode(state: &AppState) -> String {
    let tracker = state.dictation_session_tracker.lock().await;
    tracker
        .insertion_mode_at_start
        .unwrap_or(DictationInsertionMode::Auto)
        .as_settings_value()
        .to_string()
}

async fn tracker_copy_to_clipboard(state: &AppState) -> bool {
    let tracker = state.dictation_session_tracker.lock().await;
    // Matches `dictation_copy_to_clipboard`'s default: without an explicit
    // opt-in, do not leave the dictated text sitting on the user's clipboard.
    tracker.copy_to_clipboard_at_start.unwrap_or(false)
}

/// What `reprocess_dictation` was asked to do. `mode_id` is a built-in
/// preset ("voice", "messages", ...) or the id of a custom mode; `provider`
/// and `model_id` override the dictation lane's route for this run only.
#[derive(Debug, Clone)]
struct DictationReprocessRequest {
    history_id: String,
    mode_id: Option<String>,
    provider: Option<String>,
    model_id: Option<String>,
}

/// Whether a saved dictation's audio can be run again, decided from facts the
/// caller already has so the refusal can name the setting that would have
/// kept it. Pure so the policy is testable without a database or a file.
fn dictation_reprocess_audio_decision(
    audio_path: &str,
    audio_file_present: bool,
    keep_audio_enabled: bool,
    retention_preset: &str,
) -> Result<(), String> {
    if audio_path.trim().is_empty() {
        return Err(if keep_audio_enabled {
            "This dictation was saved before \"Keep dictation audio\" was turned on, so there is no audio to process again. Newer dictations keep theirs.".to_string()
        } else {
            "This dictation's audio was not kept. Turn on \"Keep dictation audio for Process again\" in Dictation settings; from then on each dictation keeps its audio until its history entry is deleted.".to_string()
        });
    }
    if !audio_file_present {
        let preset = normalize_dictation_retention_preset(retention_preset);
        return Err(if preset == "never" {
            "This dictation's audio file is no longer on disk, so it cannot be processed again."
                .to_string()
        } else {
            format!(
                "This dictation's audio file is gone. Dictation auto-delete is set to \"{}\", which removes kept audio with the entry; a longer setting keeps it for Process again.",
                preset
            )
        });
    }
    Ok(())
}

/// Resolves a requested mode id to the base preset the pipeline runs and the
/// custom mode (if any) whose prompt applies. Unknown ids fall back to the
/// active mode, the same way live dictation resolves it.
fn resolve_reprocess_mode<'a>(
    settings: &'a settings::Settings,
    mode_id: Option<&str>,
) -> (&'static str, Option<&'a settings::DictationCustomMode>) {
    if let Some(mode_id) = mode_id.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(custom) = settings
            .transcription
            .dictation_custom_modes
            .iter()
            .find(|mode| mode.id == mode_id)
        {
            let base = custom
                .base_mode_preset
                .as_deref()
                .map(normalize_dictation_base_mode_preset)
                .unwrap_or("voice");
            return (base, Some(custom));
        }
        // `normalize_dictation_mode_preset` answers "voice" for anything it
        // does not know, which would turn a stale or mistyped mode id into a
        // silent style change. Only an id that really is one of the built-in
        // presets short-circuits; everything else falls through to the mode
        // the reader is actually using.
        let preset = normalize_dictation_mode_preset(mode_id);
        if preset != "custom" && preset == mode_id {
            return (preset, None);
        }
    }
    (
        resolved_dictation_mode_preset(settings),
        active_dictation_custom_mode(settings),
    )
}

/// Runs kept dictation audio through the recognizer and the chosen style
/// again and saves the result as a new history entry linked to the original.
/// Nothing is inserted, copied to the clipboard, or shown in the popup.
async fn reprocess_dictation_impl(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    request: DictationReprocessRequest,
) -> Result<models::DictationReprocessOutcome, String> {
    // Reads stored audio, so it is excluded against backup/restore/vault work
    // exactly like meeting post-processing.
    let _postprocessing_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::PostProcess)?;
    let settings_snapshot = state.settings_manager.lock().await.settings().clone();

    let (source, dictionary_entries, snippets) = {
        let db = state.db.lock().await;
        let source = db
            .get_recording(&request.history_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That saved dictation no longer exists.".to_string())?;
        if source.source_type != "dictation" {
            return Err("Process again works on saved dictations only.".to_string());
        }
        let dictionary_entries = db
            .list_dictation_dictionary_entries()
            .map_err(|e| format!("Failed to read the dictation dictionary: {e}"))?;
        let snippets = if settings_snapshot.transcription.dictation_snippets_enabled {
            db.list_dictation_snippets()
                .map_err(|e| format!("Failed to read dictation snippets: {e}"))?
        } else {
            Vec::new()
        };
        (source, dictionary_entries, snippets)
    };

    dictation_reprocess_audio_decision(
        &source.audio_path,
        Path::new(&source.audio_path).is_file(),
        settings_snapshot.transcription.dictation_keep_audio,
        &settings_snapshot.transcription.dictation_retention_preset,
    )?;

    // Same ownership path as meeting audio: approved-root check, decryption
    // when the vault holds it, and the storage gate so a retention sweep or
    // delete cannot pull the file out from under the read.
    let audio_bytes = {
        let _storage_guard = state.audio_storage_gate.lock().await;
        let bundle = resolve_recording_audio_bundle_for_runtime(state, &source.id).await?;
        std::fs::read(&bundle.primary).map_err(|error| {
            format!(
                "Could not read this dictation's kept audio ({}): {}",
                bundle.primary.display(),
                error
            )
        })?
    };
    let duration_seconds = compute_wav_duration_seconds_from_bytes(&audio_bytes)?;

    let (provider_type, model_id) = match (&request.provider, &request.model_id) {
        (Some(provider), model) => {
            let provider_type = asr_provider_from_settings_value(provider)
                .ok_or_else(|| format!("Unknown speech engine '{provider}'."))?;
            let model_id = model
                .clone()
                .unwrap_or_else(|| provider_type.default_model_id().to_string());
            (
                provider_type,
                normalize_asr_model_id(provider_type, &model_id),
            )
        }
        (None, _) => resolve_transcription_provider_and_model(
            &settings_snapshot.transcription,
            TranscriptionScope::Dictation,
        ),
    };
    enforce_remote_asr_provider_policy(
        provider_type,
        settings_snapshot.privacy.remote_processing_enabled,
    )?;
    ensure_asr_route_ready(state, provider_type, &model_id, "process again").await?;

    let (base_preset, custom_mode) =
        resolve_reprocess_mode(&settings_snapshot, request.mode_id.as_deref());
    let base_preset = base_preset.to_string();
    let custom_mode = custom_mode.cloned();

    // The original destination app scopes the dictionary and the formatting
    // style, exactly as it did the first time.
    let original_details = {
        let db = state.db.lock().await;
        db.get_all_audit_log()
            .map_err(|e| e.to_string())?
            .into_iter()
            .rev()
            .find(|entry| {
                entry.event == "dictation_completed"
                    && entry.details.get("recording_id").and_then(|v| v.as_str())
                        == Some(source.id.as_str())
            })
            .map(|entry| dictation_history_details_from_audit(&entry.details))
            .unwrap_or_default()
    };
    let app_target = original_details
        .app_target
        .clone()
        .or_else(|| original_details.context_app_name.clone());
    let formatting_hint = resolve_dictation_formatting_hint(
        app_target.as_deref(),
        original_details.activation_matcher.as_deref(),
        original_details.context_app_name.as_deref(),
    );
    let destination_category = settings::resolve_dictation_app_category_with_overrides_and_hint(
        &settings_snapshot.transcription,
        app_target.as_deref(),
        None,
        formatting_hint.as_deref(),
    );
    // Translate-to-English follows the mode this re-run selected, not the
    // one that happens to be active now. Only the whisper-native route
    // applies here: it is a decode flag, so it costs nothing extra. The AI
    // lane is a second model pass the live path owns; "Process again" does
    // not re-run it, so a non-whisper recognizer re-runs untranslated.
    let translate_requested = match custom_mode.as_ref() {
        Some(mode) => mode.translate_to_english,
        None => {
            settings_snapshot
                .transcription
                .dictation_translate_to_english
        }
    };
    let translation_route =
        resolve_dictation_translation_route(provider_type, &model_id, translate_requested);
    let transcription_options = asr::TranscriptionOptions {
        vocabulary_hint: crate::dictation_parity::build_vocabulary_hint(
            &crate::dictation_pipeline::vocabulary_candidates_from_entries(
                &dictionary_entries,
                &snippets,
            ),
            app_target.as_deref(),
            destination_category,
        ),
        translate_to_english: translation_route == DictationTranslationRoute::WhisperNative,
        // Dictation is served correctly by either Apple engine; only the
        // meeting route depends on SpeechAnalyzer's timed segments.
        apple_speech_required_engine: None,
        request_speaker_labels: false,
        language: settings_snapshot.transcription.language.clone(),
    };

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.message = Some("Processing a saved dictation again…".to_string());
    }
    let transcription_started = std::time::Instant::now();
    let transcription_result = state
        .asr_manager
        .transcribe_bytes_for_dictation_with_options(
            provider_type,
            &audio_bytes,
            Some(model_id.as_str()),
            &transcription_options,
        )
        .await
        .map_err(|error| {
            format!(
                "Process again failed on {} / {}: {}",
                provider_type.display_name(),
                model_id,
                error
            )
        })?;
    let transcription_latency_ms = transcription_started.elapsed().as_millis() as u64;

    let raw_text =
        sanitize_dictation_output(&transcription_result.text, &transcription_result.text)
            .trim()
            .to_string();
    if raw_text.is_empty() {
        return Err(
            "The recognizer heard nothing in this dictation's audio, so there is nothing to save."
                .to_string(),
        );
    }

    // Stage two: the same local pipeline the live path runs, then the mode's
    // transform. Commands are deliberately not re-executed: a "delete that"
    // said last week must not act on whatever is focused now.
    // Numbers as digits follows the mode this re-run selected, for the same
    // reason translate-to-English above does: the selected profile's own
    // override first, then the user's setting for the preset it is built on,
    // then that preset's default.
    let numbers_as_digits = custom_mode
        .as_ref()
        .and_then(|mode| mode.numbers_as_digits)
        .unwrap_or_else(|| {
            settings_snapshot
                .transcription
                .dictation_numbers_as_digits
                .get(base_preset.as_str())
                .copied()
                .unwrap_or_else(|| {
                    settings::default_dictation_numbers_as_digits(base_preset.as_str())
                })
        });
    let pipeline_result = crate::dictation_pipeline::apply_dictation_pipeline(
        crate::dictation_pipeline::DictationPipelineInput {
            text: raw_text.as_str(),
            dictionary_entries: &dictionary_entries,
            snippets: &snippets,
            app_target: app_target.as_deref(),
            mode_preset: base_preset.as_str(),
            smart_formatting_enabled: true,
            recent_inserted_text: None,
            destination_category,
            numbers_as_digits,
        },
    );
    let mut final_text = pipeline_result.text.trim().to_string();
    let mut used_ai = false;
    let mut pipeline_stage_keys = pipeline_result.pipeline_stage_keys.clone();

    let custom_prompt = custom_mode
        .as_ref()
        .and_then(|mode| mode.custom_prompt.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let llm_allowed = settings_snapshot.transcription.dictation_ai_formatting
        || custom_mode
            .as_ref()
            .map(|mode| mode.profile == "power_rewrite")
            .unwrap_or(false);
    if !final_text.is_empty() {
        match base_preset.as_str() {
            "messages" | "email" | "meeting_follow_up" => {
                // A custom mode built on this base supplies the prompt; any
                // other custom mode must not hijack an explicit preset choice.
                let prompt = custom_prompt.clone().unwrap_or_else(|| {
                    dictation_mode_transform_prompt(&base_preset)
                        .unwrap_or_default()
                        .to_string()
                });
                if llm_allowed && !prompt.is_empty() {
                    match run_custom_dictation_transform_with_selected_provider(
                        state,
                        final_text.as_str(),
                        prompt.as_str(),
                    )
                    .await
                    {
                        Ok((output, _, _)) => {
                            final_text = output.trim().to_string();
                            used_ai = true;
                            pipeline_stage_keys.push("mode_transform".to_string());
                        }
                        Err(error) => {
                            tracing::warn!(
                                "Process again: '{}' transform fell back to the local rewrite: {}",
                                base_preset,
                                error
                            );
                            final_text = match base_preset.as_str() {
                                "messages" => rewrite_shorter_text(&final_text),
                                _ => rewrite_professional_text(&final_text),
                            };
                            pipeline_stage_keys.push("mode_transform_fallback".to_string());
                        }
                    }
                } else {
                    final_text = match base_preset.as_str() {
                        "messages" => rewrite_shorter_text(&final_text),
                        _ => rewrite_professional_text(&final_text),
                    };
                    pipeline_stage_keys.push("mode_transform_fallback".to_string());
                }
            }
            "notes" => {
                let bulletized = bulletize_text(&final_text);
                if bulletized != final_text {
                    final_text = bulletized;
                    pipeline_stage_keys.push("mode_transform".to_string());
                }
            }
            _ => {
                if let (true, Some(prompt)) = (llm_allowed, custom_prompt.as_deref()) {
                    match run_custom_dictation_transform_with_selected_provider(
                        state,
                        final_text.as_str(),
                        prompt,
                    )
                    .await
                    {
                        Ok((output, _, _)) => {
                            final_text = output.trim().to_string();
                            used_ai = true;
                            pipeline_stage_keys.push("smart_formatting".to_string());
                        }
                        Err(error) => tracing::warn!(
                            "Process again: custom-mode formatting kept the local output: {}",
                            error
                        ),
                    }
                }
            }
        }
    }
    final_text = sanitize_dictation_output(final_text.as_str(), raw_text.as_str())
        .trim()
        .to_string();
    let stored_text = if final_text.is_empty() {
        raw_text.clone()
    } else {
        final_text.clone()
    };

    // The new entry keeps its own copy of the audio, so deleting either entry
    // (by hand or by the retention sweep) never strands the other.
    let now = chrono::Utc::now();
    let recording_id = uuid::Uuid::new_v4().to_string();
    let kept_audio_path = if settings_snapshot.transcription.dictation_keep_audio {
        Some(write_kept_dictation_audio(&recording_id, &audio_bytes)?)
    } else {
        None
    };
    let kept_audio_metadata = kept_audio_path
        .as_deref()
        .map(recording_audio::validate_plaintext_wav)
        .and_then(|validation| match validation {
            recording_audio::RecordingAudioValidation::Ready(metadata) => Some(metadata),
            _ => None,
        });

    let transcript = models::Transcript {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        segments: if stored_text == raw_text {
            transcription_result
                .segments
                .iter()
                .cloned()
                .map(|segment| models::TranscriptSegment {
                    id: uuid::Uuid::new_v4().to_string(),
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                    text: segment.text,
                    speaker_id: None,
                    confidence: segment.confidence,
                })
                .collect()
        } else {
            vec![models::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                start_time: 0.0,
                end_time: 0.0,
                text: stored_text.clone(),
                speaker_id: None,
                confidence: transcription_result.confidence,
            }]
        },
        full_text: stored_text.clone(),
        language: transcription_result.language.clone(),
        confidence: transcription_result.confidence,
        model: transcription_result.model_name.clone(),
        model_id: Some(transcription_result.model_id.clone()),
        requested_provider: Some(asr_provider_to_settings_value(provider_type).to_string()),
        actual_provider: Some(
            asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
        ),
        created_at: now,
    };
    let mode_label = custom_mode
        .as_ref()
        .map(|mode| mode.name.clone())
        .unwrap_or_else(|| {
            dictation_mode_label(
                &base_preset,
                None,
                &settings_snapshot.transcription.dictation_custom_modes,
            )
        });
    let recording = models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Dictation (processed again, {}) - {}",
            mode_label,
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: source.project_id.clone(),
        duration: duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "dictation".to_string(),
        audio_path: kept_audio_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        status: "completed".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: None,
        meeting_template_id: None,
        meeting_capture_mode: None,
        imported_source_name: None,
        notes_updated_at: None,
        consent_prompt_shown: false,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        pause_spans: Vec::new(),
        video_service: None,
        attendees: Vec::new(),
    };
    let history_text = crate::store::DictationHistoryTextRecord {
        recording_id: recording_id.clone(),
        final_text: stored_text.clone(),
        raw_text: raw_text.clone(),
        reprocessed_from_id: Some(source.id.clone()),
        mode_preset: Some(base_preset.clone()),
        created_at: now,
    };

    {
        let mut db = state.db.lock().await;
        if let Err(error) = db.create_dictation_history_entry(
            &recording,
            &transcript,
            &history_text,
            kept_audio_metadata.as_ref(),
        ) {
            if let Some(path) = kept_audio_path.as_deref() {
                let _ = std::fs::remove_file(path);
            }
            return Err(format!(
                "Plainsong could not save the processed-again dictation: {error}"
            ));
        }
        let _ = db.save_transcript_artifact(&TranscriptArtifactRecord {
            id: uuid::Uuid::new_v4().to_string(),
            recording_id: recording_id.clone(),
            transcript_id: Some(transcript.id.clone()),
            segment_count: transcript.segments.len() as i64,
            model_id: Some(transcription_result.model_id.clone()),
            requested_provider: Some(asr_provider_to_settings_value(provider_type).to_string()),
            actual_provider: Some(
                asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
            ),
            quality_score: Some(transcription_result.confidence),
            startup_latency_ms: None,
            transcription_latency_ms: Some(transcription_latency_ms as i64),
            insert_latency_ms: None,
            end_to_end_ms: Some(transcription_latency_ms as i64),
            created_at: now,
        });
        // Mirrors `dictation_completed` closely enough that the history
        // inspector reads the new entry through the same code path.
        let _ = db.log_audit_event(
            "dictation_completed",
            Some(serde_json::json!({
                "recording_id": &recording_id,
                "reprocessed_from_id": &source.id,
                "stop_reason": "process_again",
                "dictation_mode_preset": custom_mode.as_ref().map(|_| "custom").unwrap_or(base_preset.as_str()),
                "dictation_mode_label": mode_label,
                "dictation_base_mode_preset": &base_preset,
                "dictation_custom_mode_id": custom_mode.as_ref().map(|mode| mode.id.clone()),
                "dictation_custom_mode_name": custom_mode.as_ref().map(|mode| mode.name.clone()),
                "app_target": app_target,
                "dictionary_applied_count": pipeline_result.dictionary_applied_count,
                "snippet_applied_count": pipeline_result.snippet_applied_count,
                "formatting_applied": used_ai || pipeline_result.formatting_applied,
                "pipeline_stage_keys": pipeline_stage_keys,
                "requested_provider": asr_provider_to_settings_value(provider_type),
                "actual_provider": asr_provider_to_settings_value(transcription_result.actual_provider),
                "model_id": &transcription_result.model_id,
                "transcription_latency_ms": transcription_latency_ms,
                "outcome": "saved",
            })),
            "info",
        );
        let _ = db.log_audit_event(
            "dictation_reprocessed",
            Some(serde_json::json!({
                "recording_id": &recording_id,
                "reprocessed_from_id": &source.id,
                "mode_preset": &base_preset,
                "custom_mode_id": custom_mode.as_ref().map(|mode| mode.id.clone()),
                "provider": asr_provider_to_settings_value(transcription_result.actual_provider),
                "model_id": &transcription_result.model_id,
                "used_ai": used_ai,
                "duration_seconds": duration_seconds,
                "transcription_latency_ms": transcription_latency_ms,
            })),
            "info",
        );
    }
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.message = None;
    }
    handle.emit_event(
        "dictation-history-changed",
        serde_json::json!({
            "recordingId": &recording_id,
            "reprocessedFromId": &source.id,
        }),
    );

    Ok(models::DictationReprocessOutcome {
        recording,
        transcript,
        final_text: stored_text,
        raw_text,
        mode_preset: base_preset,
        custom_mode_id: custom_mode.as_ref().map(|mode| mode.id.clone()),
        custom_mode_name: custom_mode.as_ref().map(|mode| mode.name.clone()),
        provider: asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
        model_id: transcription_result.model_id.clone(),
        used_ai,
        reprocessed_from_id: source.id.clone(),
        reprocessed_from_created_at: source.created_at,
        transcription_latency_ms,
    })
}

/// Writes a dictation's captured WAV into the recordings store under a name
/// that cannot collide, and returns its path. The caller registers it as the
/// entry's owned primary asset in the same transaction as the row.
fn write_kept_dictation_audio(recording_id: &str, audio_bytes: &[u8]) -> Result<PathBuf, String> {
    let recordings_dir = nautilus_data_root()?.join("recordings");
    std::fs::create_dir_all(&recordings_dir).map_err(|error| {
        format!(
            "Failed to prepare the recordings folder '{}': {}",
            recordings_dir.display(),
            error
        )
    })?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let short_id: String = recording_id.chars().take(8).collect();
    let path = recordings_dir.join(format!("dictation_{timestamp}_{short_id}.wav"));
    std::fs::write(&path, audio_bytes).map_err(|error| {
        format!(
            "Failed to keep the dictation audio at '{}': {}",
            path.display(),
            error
        )
    })?;
    Ok(path)
}

async fn reprocess_dictation_text_impl(
    state: &AppState,
    text: String,
    mode_preset: String,
    app_target: Option<String>,
) -> Result<serde_json::Value, String> {
    let input = text.trim();
    if input.is_empty() {
        return Err("Dictation text is empty.".to_string());
    }

    let normalized_mode = normalize_dictation_mode_preset(&mode_preset).to_string();
    let reprocess_settings = state.settings_manager.lock().await.settings().clone();
    let effective_mode = if normalized_mode == "custom" {
        resolved_dictation_mode_preset(&reprocess_settings).to_string()
    } else {
        normalized_mode.clone()
    };
    let formatting_hint = resolve_dictation_formatting_hint(app_target.as_deref(), None, None);

    let (output_text, used_ai, provider, model_id) = match effective_mode.as_str() {
        "messages" | "email" | "meeting_follow_up" => {
            // Reprocess honours the active custom mode's own prompt for exactly
            // the same reason live dictation does; see
            // `resolve_dictation_mode_transform_prompt`.
            let (prompt, _prompt_source) =
                resolve_dictation_mode_transform_prompt(&reprocess_settings, &effective_mode)
                    .ok_or_else(|| {
                        "No transform prompt is configured for this mode.".to_string()
                    })?;
            match run_custom_dictation_transform_with_selected_provider(
                state,
                input,
                prompt.as_str(),
            )
            .await
            {
                Ok((output, provider, model_id)) => (
                    output,
                    true,
                    Some(provider.as_settings_value().to_string()),
                    Some(model_id),
                ),
                Err(error) => {
                    let fallback = match effective_mode.as_str() {
                        "messages" => rewrite_shorter_text(input),
                        "email" => rewrite_professional_text(input),
                        "meeting_follow_up" => rewrite_professional_text(input),
                        _ => input.to_string(),
                    };
                    tracing::warn!(
                        "Dictation reprocess for mode '{}' fell back to local transform: {}",
                        effective_mode,
                        error
                    );
                    (fallback, false, None, None)
                }
            }
        }
        "notes" => (bulletize_text(input), false, None, None),
        "voice" | "custom" => (
            crate::text::format::smart_format_dictation_text_for_app(
                sanitize_dictation_output(input, input).trim(),
                &effective_mode,
                formatting_hint.as_deref(),
            )
            .trim()
            .to_string(),
            false,
            None,
            None,
        ),
        _ => (
            crate::text::format::smart_format_dictation_text_for_app(
                sanitize_dictation_output(input, input).trim(),
                &effective_mode,
                formatting_hint.as_deref(),
            )
            .trim()
            .to_string(),
            false,
            None,
            None,
        ),
    };

    Ok(serde_json::json!({
        "modePreset": effective_mode,
        "outputText": output_text,
        "usedAi": used_ai,
        "provider": provider,
        "modelId": model_id
    }))
}

/// Scope a selected-text transform actually ran against: an explicit text
/// selection in the frontmost app, or (Quick-Fix-style commands only) the
/// whole contents of the currently focused field when there was no
/// selection to capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectedTextTransformTargetScope {
    Selection,
    FocusedField,
}

impl SelectedTextTransformTargetScope {
    fn as_result_value(self) -> &'static str {
        match self {
            Self::Selection => "selection",
            Self::FocusedField => "focused_field",
        }
    }
}

#[derive(Debug)]
struct SelectedTextTransformTarget {
    text: String,
    scope: SelectedTextTransformTargetScope,
}

/// Runs a dictation command (by `command_key`) against `input_text`,
/// dispatching to a pure-Rust local transform for the four case-transform
/// commands, or to the AI-backed path (with local-transform fallback on
/// error) for everything else. `app_category` is an optional supplemental
/// hint — the same `DictationAppCategory` resolved for the existing
/// dictation-formatting prompt — appended to the AI prompt via
/// `append_category_prompt_fragment` so destination-app guardrails (e.g.
/// "don't touch code" for a code editor) apply here too, without
/// introducing a second, independent app-context branch.
async fn transform_text_with_command(
    state: &AppState,
    command_key: &str,
    input_text: &str,
    action_label: &str,
    app_category: Option<text::format::DictationAppCategory>,
) -> Result<DictationTextTransformOutput, String> {
    if crate::dictation_parity::is_local_only_selected_text_command(command_key) {
        let raw_output = local_dictation_command_transform(command_key, input_text)?;
        let output_text = sanitize_dictation_output(raw_output.trim(), input_text)
            .trim()
            .to_string();
        if output_text.is_empty() {
            return Err(format!("{} result is empty.", action_label));
        }

        return Ok(DictationTextTransformOutput {
            output_text,
            used_ai: false,
            provider: None,
            model_id: None,
        });
    }

    let base_prompt = resolve_dictation_command_prompt(state, command_key).await?;
    let category_fragment = app_category.and_then(text::format::dictation_category_prompt_fragment);
    let prompt = append_category_prompt_fragment(base_prompt, category_fragment);

    let (raw_output, used_ai, provider, model_id) =
        match run_custom_dictation_transform_with_selected_provider(state, input_text, &prompt)
            .await
        {
            Ok((output, provider, model_id)) => (
                output,
                true,
                Some(provider.as_settings_value().to_string()),
                Some(model_id),
            ),
            Err(error) => {
                tracing::warn!("{} fell back to local transform: {}", action_label, error);
                (
                    local_dictation_command_transform(command_key, input_text)?,
                    false,
                    None,
                    None,
                )
            }
        };
    let output_text = sanitize_dictation_output(raw_output.trim(), input_text)
        .trim()
        .to_string();
    if output_text.is_empty() {
        return Err(format!("{} result is empty.", action_label));
    }

    Ok(DictationTextTransformOutput {
        output_text,
        used_ai,
        provider,
        model_id,
    })
}

struct DictationTextTransformOutput {
    output_text: String,
    used_ai: bool,
    provider: Option<String>,
    model_id: Option<String>,
}

/// Dispatches `command_key` to whichever local text-transform function
/// backs it. Only the commands with local implementations today are
/// supported: the four case-transform primitives (via `dictation_parity`)
/// plus the three commands with an existing local AI-fallback
/// implementation on main (`rewrite_shorter`, `rewrite_professional`,
/// `bulletize_selection`). Every other AI-backed selected-text command
/// (e.g. `expand_text`, `summarize_text`, `prompt_engineer`) has a default
/// prompt via `default_dictation_command_prompt` and runs through the AI
/// provider in `transform_text_with_command`; if that call fails, this
/// function's `_ => Err(...)` arm surfaces a "fell back to local transform"
/// warning and a plain error for those commands rather than a crude local
/// rewrite, since no local heuristic exists for them.
fn local_dictation_command_transform(command_key: &str, input: &str) -> Result<String, String> {
    match command_key {
        "rewrite_shorter" => Ok(rewrite_shorter_text(input)),
        "rewrite_professional" => Ok(rewrite_professional_text(input)),
        "bulletize_selection" => Ok(bulletize_text(input)),
        "uppercase_selection" => crate::dictation_parity::uppercase_context_selection(input),
        "lowercase_selection" => crate::dictation_parity::lowercase_context_selection(input),
        "title_case_selection" => crate::dictation_parity::title_case_context_selection(input),
        "sentence_case_selection" => {
            crate::dictation_parity::sentence_case_context_selection(input)
        }
        _ => Err(format!(
            "Unsupported dictation command transform: {}",
            command_key
        )),
    }
}

/// Resolves the destination-app category for a selected-text transform the
/// same way the dictation-formatting prompt resolves it: via
/// `resolve_dictation_app_category_with_overrides`, using the transform
/// target app's name/bundle id. Returned as an optional hint so callers can
/// append it as a supplement to the transform prompt without it ever being
/// required.
///
/// Like `run_dictation_formatting_with_selected_provider`, this is a
/// prompt-fragment consumer, so it respects
/// `dictation_category_formatting_enabled` itself (returning `Other` when
/// disabled) rather than relying on the resolver to gate it — the resolver
/// always returns the real category so non-prompt consumers (e.g.
/// dictionary/snippet `category_scope` matching) are unaffected by this
/// toggle.
async fn resolve_selected_text_transform_app_category(
    state: &AppState,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> text::format::DictationAppCategory {
    let settings = state.settings_manager.lock().await.settings().clone();
    if !settings.transcription.dictation_category_formatting_enabled {
        return text::format::DictationAppCategory::Other;
    }
    settings::resolve_dictation_app_category_with_overrides(
        &settings.transcription,
        target_app,
        target_app_bundle_id,
    )
}

/// Implements the "transform text selected in any app" feature: captures
/// the transform target (an explicit selection, falling back to the whole
/// focused field for Quick-Fix-style commands only), runs the requested
/// command against it, and writes the result back in place using whichever
/// system-wide write path matches how the target was captured.
async fn transform_selected_text_impl(
    state: &AppState,
    command_key: &str,
) -> Result<serde_json::Value, String> {
    let action_label = crate::dictation_parity::dictation_command_selected_text_label(command_key)
        .ok_or_else(|| format!("Unsupported selected-text transform: {}", command_key))?;

    #[cfg(target_os = "macos")]
    let target = {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    };

    #[cfg(target_os = "windows")]
    let target = (get_frontmost_app_name(), None);

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let transform_target = capture_selected_text_transform_target(
            command_key,
            action_label,
            target.0.as_deref(),
            target.1.as_deref(),
        )?;
        let input_text = transform_target.text;
        let app_category = resolve_selected_text_transform_app_category(
            state,
            target.0.as_deref(),
            target.1.as_deref(),
        )
        .await;
        let transform = transform_text_with_command(
            state,
            command_key,
            input_text.as_str(),
            action_label,
            Some(app_category),
        )
        .await?;

        let paste_outcome = match transform_target.scope {
            SelectedTextTransformTargetScope::Selection => paste_text_systemwide(
                &state.accessibility_trust_observed,
                transform.output_text.as_str(),
                true,
                target.0.as_deref(),
                target.1.as_deref(),
            ),
            SelectedTextTransformTargetScope::FocusedField => {
                replace_focused_field_text_systemwide(
                    transform.output_text.as_str(),
                    target.0.as_deref(),
                    target.1.as_deref(),
                )
            }
        };

        Ok(serde_json::json!({
            "commandKey": command_key,
            "inputText": input_text,
            "outputText": transform.output_text,
            "targetScope": transform_target.scope.as_result_value(),
            "targetApp": target.0,
            "targetBundleId": target.1,
            "pasted": paste_outcome.pasted,
            "copied": paste_outcome.copied,
            "error": paste_outcome.error,
            "usedAi": transform.used_ai,
            "provider": transform.provider,
            "modelId": transform.model_id,
        }))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state;
        let _ = command_key;
        Err("Selected-text transforms are only supported on macOS and Windows.".to_string())
    }
}

/// Pure scope-selection policy behind `capture_selected_text_transform_target`
/// (macOS): given the *result* of trying to capture an explicit selection
/// and (lazily) the *result* of trying to capture the focused-field
/// contents, decides whether the transform target is the selection, the
/// focused field, or an error — without itself touching the clipboard or
/// Accessibility APIs. Factored out so this branching logic can be unit
/// tested deterministically, independent of the live OS permission state
/// that the real capture functions depend on.
///
/// `focused_field_capture` is a closure (rather than an already-computed
/// value) so the real caller only pays the Accessibility round-trip when
/// this policy actually needs it, matching the original inline control
/// flow's laziness.
fn resolve_selected_text_transform_target(
    command_key: &str,
    action_label: &str,
    selection_capture: Result<Option<String>, String>,
    focused_field_capture: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<SelectedTextTransformTarget, String> {
    let allows_focused_field_fallback =
        crate::dictation_parity::allows_focused_field_fallback(command_key);

    match selection_capture {
        Ok(Some(text)) => {
            return Ok(SelectedTextTransformTarget {
                text,
                scope: SelectedTextTransformTargetScope::Selection,
            });
        }
        Ok(None) => {}
        Err(selection_error) => {
            if !allows_focused_field_fallback {
                return Err(selection_error);
            }
            if let Some(text) = focused_field_capture()? {
                return Ok(SelectedTextTransformTarget {
                    text,
                    scope: SelectedTextTransformTargetScope::FocusedField,
                });
            }
            return Err(selection_error);
        }
    }

    if allows_focused_field_fallback {
        if let Some(text) = focused_field_capture()? {
            return Ok(SelectedTextTransformTarget {
                text,
                scope: SelectedTextTransformTargetScope::FocusedField,
            });
        }
        return Err(format!(
            "Select text or focus a text field to transform, then run {}.",
            action_label
        ));
    }

    Err(format!(
        "Select text to transform, then run {}.",
        action_label
    ))
}

#[cfg(target_os = "macos")]
fn capture_selected_text_transform_target(
    command_key: &str,
    action_label: &str,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<SelectedTextTransformTarget, String> {
    resolve_selected_text_transform_target(
        command_key,
        action_label,
        capture_selected_text_via_clipboard(target_app),
        || capture_focused_field_text_via_accessibility(target_app, target_app_bundle_id),
    )
}

#[cfg(target_os = "windows")]
fn capture_selected_text_transform_target(
    _command_key: &str,
    action_label: &str,
    target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) -> Result<SelectedTextTransformTarget, String> {
    let text = capture_selected_text_via_clipboard(target_app)?
        .ok_or_else(|| format!("Select text to transform, then run {}.", action_label))?;
    Ok(SelectedTextTransformTarget {
        text,
        scope: SelectedTextTransformTargetScope::Selection,
    })
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
        "'{}' can only clean up dictation; it cannot run a custom transform prompt. Choose Ollama or a cloud provider for custom modes and dictation commands.",
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
        "'{}' only cleans up dictation and cannot write meeting summaries. Choose Ollama or a cloud provider for the meetings lane in Models.",
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
mod dictation_idle_reset_tests {
    use super::dictation_idle_reset_applies;

    /// The timer scheduled for the session that is still on screen must fire;
    /// this is what stops a failed dictation from parking an always-on-top
    /// panel over the user's work until they hunt down the close button.
    #[test]
    fn a_reset_applies_to_the_session_it_was_scheduled_for() {
        assert!(dictation_idle_reset_applies(Some(7), 7));
        assert!(dictation_idle_reset_applies(None, 7));
    }

    /// ...but a timer from an older session must not hide the HUD of a session
    /// the user just started.
    #[test]
    fn a_stale_reset_never_hides_a_newer_sessions_hud() {
        assert!(!dictation_idle_reset_applies(Some(8), 7));
    }

    /// `fail_dictation_stop` needs a live `AppState` to run, so the invariant
    /// that made a failed dictation park an always-on-top panel forever --- it
    /// emitted a terminal `error` phase and scheduled no reset, unlike the
    /// success path --- is asserted against its shape instead.
    #[test]
    fn the_terminal_error_path_schedules_its_own_idle_reset() {
        const SOURCE: &str = include_str!("lib.rs");
        let start = SOURCE
            .find("\nasync fn fail_dictation_stop(")
            .expect("fail_dictation_stop must exist");
        let end = start
            + SOURCE[start..]
                .find("\n}\n")
                .expect("fail_dictation_stop must be closed");
        let body = &SOURCE[start..end];

        assert!(
            body.contains("schedule_dictation_overlay_idle_reset("),
            "fail_dictation_stop must schedule an idle reset; without one the error HUD stays \
             on screen, always on top, until the user finds the close button"
        );
        assert!(
            body.contains("DICTATION_IDLE_RESET_ERROR_MS"),
            "the error path must use the longer error window, not the success one"
        );
        // Every terminal stop failure funnels through here, and several of
        // them (audio finalization failing, an unreadable capture) happen
        // before the success path's own close. Without this the streaming
        // preview would keep its recognizer -- and its model -- alive after
        // the session it belonged to had already ended in an error.
        assert!(
            body.contains("stop_dictation_live_preview(state).await;"),
            "the terminal error path must close the live preview; a failed stop otherwise \
             leaves the streaming engine loaded with no session to end it"
        );
        let close = body
            .find("stop_dictation_live_preview(state).await;")
            .expect("the error path must close the live preview");
        let reset = body
            .find("reset_dictation_session_runtime(")
            .expect("the error path must reset the session runtime");
        assert!(
            close < reset,
            "the preview must be closed before the session runtime is reset, so nothing is \
             still feeding a session that no longer exists"
        );
    }
}

#[cfg(test)]
mod recent_dictation_result_tests {
    use super::{
        push_recent_dictation_result, RecentDictationResult, RECENT_DICTATION_RESULT_LIMIT,
    };

    fn result(text: &str) -> RecentDictationResult {
        RecentDictationResult {
            text: text.to_string(),
            app_target: None,
            app_bundle_id: None,
            at_ms: 0,
        }
    }

    /// The recovery hotkeys bind to index 0, so "most recent" has to be the
    /// first entry — re-pasting the oldest of three results would be worse
    /// than doing nothing.
    #[test]
    fn newest_result_is_first_and_the_list_is_capped() {
        let mut results = Vec::new();
        for index in 0..6 {
            push_recent_dictation_result(&mut results, result(&format!("result {index}")));
        }

        assert_eq!(results.len(), RECENT_DICTATION_RESULT_LIMIT);
        assert_eq!(results[0].text, "result 5");
        assert_eq!(results[2].text, "result 3");
    }

    /// A session that produced nothing (silence, a cancelled command) must not
    /// push a blank entry that shadows the last result the user actually wants
    /// back.
    #[test]
    fn blank_results_are_not_offered_for_recovery() {
        let mut results = vec![result("keep me")];

        push_recent_dictation_result(&mut results, result(""));
        push_recent_dictation_result(&mut results, result("   \n  "));

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "keep me");
    }

    /// Source of `reuse_recent_dictation_result`. It needs a live `AppState`
    /// and a real macOS window server to run, so the invariant that keeps the
    /// recovery hotkey from hijacking the user's frontmost app is asserted
    /// against its shape — the same approach `owned_stop_dictation_body` takes.
    fn reuse_recent_dictation_result_body() -> &'static str {
        const SOURCE: &str = include_str!("lib.rs");

        let start = SOURCE
            .find("\nfn reuse_recent_dictation_result(")
            .expect("reuse_recent_dictation_result must exist");
        let end = start
            + SOURCE[start..]
                .find("\n}\n")
                .expect("reuse_recent_dictation_result must be closed");
        &SOURCE[start..end]
    }

    /// The recovery hotkey is pressed *after* the user has moved on — that is
    /// what it is for. Handing the stored session's app back to
    /// `paste_text_systemwide` makes `reactivate_target_application` shell
    /// `open -b <bundle>`, which raises (or relaunches, since nothing expires
    /// this list) the old app and inserts there instead of at the caret the
    /// user is actually looking at.
    #[test]
    fn repaste_targets_the_current_frontmost_app_not_the_original_one() {
        let body = reuse_recent_dictation_result_body();

        assert!(
            body.contains("resolve_recent_dictation_repaste_target()"),
            "the re-paste target must be re-resolved at re-paste time"
        );
        assert!(
            !body.contains("result.app_target"),
            "the stored session's app must not be reactivated by the recovery hotkey"
        );
        assert!(
            !body.contains("result.app_bundle_id"),
            "the stored session's bundle id must not be reactivated by the recovery hotkey"
        );
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests;

fn default_speaker_color(index: usize) -> String {
    const COLORS: [&str; 6] = [
        "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#6366F1", "#14B8A6",
    ];
    COLORS[index % COLORS.len()].to_string()
}

fn dictation_options_from_settings(settings: &settings::Settings) -> models::DictationStartOptions {
    let active_language_override = if settings.transcription.language.is_none()
        && settings.transcription.dictation_active_languages.len() == 1
    {
        settings
            .transcription
            .dictation_active_languages
            .first()
            .cloned()
    } else {
        None
    };

    models::DictationStartOptions {
        save_to_inbox: settings.transcription.dictation_save_to_inbox,
        project_id: Some(settings.transcription.dictation_project_id.clone()),
        profile: dictation_profile_from_settings_value(&settings.transcription.dictation_profile),
        context_source: normalize_dictation_context_source(
            &settings.transcription.dictation_context_source,
        )
        .to_string(),
        route_preference: Some(settings.transcription.dictation_route_preference.clone()),
        language_override: settings
            .transcription
            .language
            .clone()
            .or(active_language_override),
        live_preview_enabled: Some(settings.transcription.dictation_live_preview_enabled),
        requested_provider: None,
        requested_model_id: None,
        actual_provider: None,
        actual_model_id: None,
        resolved_route: None,
        provider_model_label: None,
        resolved_hosting: None,
        captured_context_text: None,
        context_app_name: None,
        context_app_bundle_id: None,
        resolved_mode_preset: None,
        resolved_custom_mode_id: None,
        resolved_mode_label: None,
        activation_matcher: None,
        preferred_input_device_id: settings
            .audio
            .dictation_input_device
            .as_ref()
            .filter(|_| settings.audio.dictation_input_override_enabled)
            .or(settings.audio.preferred_input_device.as_ref())
            .map(|device| device.device_id.clone()),
        delivery_mode: models::DictationDeliveryMode::System,
        // Never inferred from settings: this is a property of how a specific
        // start was triggered, and only the caller that received the
        // `hands_free_start` signal knows it.
        hands_free_trigger: false,
        mode_override: None,
    }
}

fn normalize_optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_dictation_custom_mode(
    mode: &mut settings::DictationCustomMode,
    fallback_ai_provider: &str,
    fallback_ai_model: Option<&str>,
) {
    mode.name = mode.name.trim().to_string();
    if mode.name.is_empty() {
        mode.name = "Custom Mode".to_string();
    }
    mode.description = mode.description.trim().to_string();
    mode.profile =
        dictation_profile_to_settings_value(&dictation_profile_from_settings_value(&mode.profile))
            .to_string();
    mode.route_preference = mode
        .route_preference
        .clone()
        .map(|preference| normalize_dictation_route_preference(&preference).to_string());
    mode.language_override = normalize_optional_trimmed(mode.language_override.clone());
    mode.insertion_mode = normalize_dictation_insertion_mode(&mode.insertion_mode).to_string();
    mode.context_source = normalize_dictation_context_source(&mode.context_source).to_string();
    mode.dictation_provider =
        normalize_optional_trimmed(mode.dictation_provider.clone()).map(|provider| {
            asr_provider_to_settings_value(
                asr_provider_from_settings_value(&provider)
                    .unwrap_or(asr::AsrProviderType::Whisper),
            )
            .to_string()
        });
    mode.dictation_model_id = normalize_optional_trimmed(mode.dictation_model_id.clone());
    mode.ai_provider = normalize_optional_trimmed(mode.ai_provider.clone()).or_else(|| {
        let normalized = AnalysisProvider::from_settings_value(fallback_ai_provider)
            .expect("fallback analysis provider is validated before custom modes")
            .as_settings_value()
            .to_string();
        Some(normalized)
    });
    mode.ai_model_id = normalize_optional_trimmed(mode.ai_model_id.clone())
        .or_else(|| fallback_ai_model.map(str::to_string));
    mode.activation_app_matcher = normalize_optional_trimmed(mode.activation_app_matcher.clone());
    mode.activation_domain_matcher =
        normalize_optional_trimmed(mode.activation_domain_matcher.clone());
}

fn extract_host_from_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let host = without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme)
        .split('@')
        .next_back()
        .unwrap_or(without_scheme)
        .split(':')
        .next()
        .unwrap_or(without_scheme)
        .trim()
        .trim_start_matches("www.");
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

fn custom_mode_matches_context(
    mode: &settings::DictationCustomMode,
    app_name: Option<&str>,
    browser_url: Option<&str>,
) -> Option<String> {
    if let Some(matcher) = mode.activation_domain_matcher.as_deref() {
        let normalized_matcher = matcher
            .trim()
            .trim_start_matches("www.")
            .to_ascii_lowercase();
        if !normalized_matcher.is_empty() {
            if let Some(active_domain) = browser_url.and_then(extract_host_from_url) {
                if active_domain == normalized_matcher
                    || active_domain.ends_with(&format!(".{}", normalized_matcher))
                {
                    return Some(matcher.trim().to_string());
                }
            }
        }
    }

    if let Some(matcher) = mode.activation_app_matcher.as_deref() {
        if let Some(active_app) = app_name.map(str::trim).filter(|value| !value.is_empty()) {
            if active_app
                .to_ascii_lowercase()
                .contains(&matcher.trim().to_ascii_lowercase())
            {
                return Some(matcher.trim().to_string());
            }
        }
    }

    None
}

fn dictation_mode_label(
    mode_preset: &str,
    selected_custom_mode_id: Option<&str>,
    custom_modes: &[settings::DictationCustomMode],
) -> String {
    match normalize_dictation_mode_preset(mode_preset) {
        "messages" => "Messages".to_string(),
        "email" => "Email".to_string(),
        "notes" => "Notes".to_string(),
        "meeting_follow_up" => "Meeting Follow-up".to_string(),
        "custom" => selected_custom_mode_id
            .and_then(|selected_id| {
                custom_modes
                    .iter()
                    .find(|mode| mode.id == selected_id)
                    .map(|mode| mode.name.clone())
            })
            .unwrap_or_else(|| "Custom".to_string()),
        _ => "Voice".to_string(),
    }
}

#[allow(clippy::too_many_arguments)]
fn resolve_dictation_formatting_hint(
    app_target: Option<&str>,
    activation_matcher: Option<&str>,
    context_app_name: Option<&str>,
) -> Option<String> {
    activation_matcher
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            app_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .or_else(|| {
            context_app_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

fn dictation_profile_to_settings_value(profile: &models::DictationProfile) -> &'static str {
    match profile {
        models::DictationProfile::NormalSpeed => "normal_speed",
        models::DictationProfile::PowerRewrite => "power_rewrite",
    }
}

fn dictation_profile_from_settings_value(value: &str) -> models::DictationProfile {
    match value {
        "power_rewrite" | "accuracy" => models::DictationProfile::PowerRewrite,
        _ => models::DictationProfile::NormalSpeed,
    }
}

fn normalize_dictation_command_prefix(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        DICTATION_COMMAND_PREFIX_DEFAULT
    } else {
        trimmed
    }
}

fn normalize_dictation_mode_preset(value: &str) -> &'static str {
    match value.trim() {
        "voice" => "voice",
        "messages" => "messages",
        "email" => "email",
        "notes" => "notes",
        "meeting_follow_up" => "meeting_follow_up",
        "custom" => "custom",
        _ => "voice",
    }
}

fn normalize_dictation_context_source(value: &str) -> &'static str {
    match value {
        "clipboard" => "clipboard",
        "selected_text" => "selected_text",
        "application_context" => "application_context",
        _ => "none",
    }
}

fn normalize_dictation_route_preference(value: &str) -> &'static str {
    match value {
        "cloud" => "cloud",
        _ => "local",
    }
}

fn normalize_dictation_insertion_mode(value: &str) -> &'static str {
    DictationInsertionMode::from_settings_value(value).as_settings_value()
}

/// Whether the dictation model should be pre-warmed on session start.
///
/// Only "off" turns it off. The retired "short"/"long" values were two names
/// for the same (unconditional) behavior, so they read as on.
fn dictation_keep_warm_enabled(value: &str) -> bool {
    value.trim() != "off"
}

/// Last answer from the Apple Foundation Models availability probe.
///
/// Probed once at startup and cached: the answer only changes when the user
/// changes a System Settings switch or finishes an OS-level model download,
/// and spawning a helper process on every readiness render would be a
/// per-frame process spawn. `refresh_apple_language_model_availability` is
/// the escape hatch for a user who just turned Apple Intelligence on.
static APPLE_LANGUAGE_MODEL_AVAILABILITY: LazyLock<
    StdMutex<Option<llm::apple_language_model::AppleModelAvailability>>,
> = LazyLock::new(|| StdMutex::new(None));

fn cached_apple_language_model_availability(
) -> Option<llm::apple_language_model::AppleModelAvailability> {
    APPLE_LANGUAGE_MODEL_AVAILABILITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn store_apple_language_model_availability(
    availability: llm::apple_language_model::AppleModelAvailability,
) {
    *APPLE_LANGUAGE_MODEL_AVAILABILITY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(availability);
}

/// Re-probe and cache. Never prompts and never downloads anything.
async fn refresh_apple_language_model_availability(
) -> llm::apple_language_model::AppleModelAvailability {
    let availability = llm::apple_language_model::probe().await;
    store_apple_language_model_availability(availability.clone());
    availability
}

#[cfg(test)]
fn schedule_apple_language_model_probe() {
    // Unit tests must not spawn the packaged helper: it is not built in a
    // `cargo test` tree, and the answer would depend on whether the machine
    // running the suite happens to have Apple Intelligence switched on.
    // `parse_helper_line` and `availability_from_response` carry the
    // behavior deterministically.
}

#[cfg(not(test))]
fn schedule_apple_language_model_probe() {
    tokio::spawn(async {
        let availability = refresh_apple_language_model_availability().await;
        if availability.available {
            tracing::info!("Apple on-device language model is available for dictation cleanup");
        } else {
            tracing::info!(
                "Apple on-device language model unavailable ({}): {}",
                availability.reason.as_deref().unwrap_or("unknown"),
                availability.detail.as_deref().unwrap_or("no detail")
            );
        }
    });
}

#[cfg(test)]
fn schedule_bundled_cleanup_prewarm(_settings: &settings::Settings) {
    // Same reason as `schedule_dictation_model_prewarm`'s test stub: loading a
    // 484 MB GGUF into the test process (against the user's real Application
    // Support directory) would make the suite own native global state.
}

/// Load the bundled cleanup model in the background when it is the selected
/// dictation route and keep-warm is on, so the first dictation of the session
/// does not spend its 6 s budget on a cold load.
#[cfg(not(test))]
fn schedule_bundled_cleanup_prewarm(settings: &settings::Settings) {
    if settings
        .privacy
        .ai_lane(settings::AiLane::Dictation)
        .provider
        != llm::bundled_local::PROVIDER_SETTINGS_VALUE
    {
        return;
    }
    if !dictation_keep_warm_enabled(&settings.transcription.dictation_keep_warm) {
        return;
    }
    let Some(models_root) =
        crate::paths::data_dir().map(|dir| dir.join("Plainsong").join("models"))
    else {
        return;
    };
    if !llm::bundled_local::artifacts_trusted(&llm::bundled_local::model_dir(&models_root)) {
        // Not downloaded yet, or a receipt did not verify. The Models screen
        // is where that gets fixed; a warmup is not the place to say so.
        return;
    }
    tokio::task::spawn_blocking(move || match llm::bundled_local::prewarm(&models_root) {
        Ok(backend) => tracing::info!(
            "{} by {} warmed on {}",
            llm::bundled_local::MODEL_DISPLAY_NAME,
            llm::bundled_local::MODEL_VENDOR,
            backend
        ),
        Err(error) => tracing::warn!("Bundled cleanup model warmup failed: {}", error),
    });
}

/// Mirror the keep-warm setting into the bundled cleanup provider.
///
/// `keep_warm: "off"` used to mean only "skip the prewarm": the first real
/// cleanup loaded the model anyway and nothing short of deleting it ever let
/// go, so the switch saved memory exactly until the first dictation. The
/// provider now unloads itself after an idle interval when this is off, and
/// this is where the setting reaches it -- at startup and on every save, the
/// same two places the prewarm is scheduled from.
fn apply_bundled_cleanup_keep_warm(settings: &settings::Settings) {
    llm::bundled_local::set_keep_warm(dictation_keep_warm_enabled(
        &settings.transcription.dictation_keep_warm,
    ));
}

/// Whether switching the dictation lane from `previous` to `next` should drop
/// the resident bundled model.
///
/// Pointing the lane at Ollama or a cloud provider means nothing will ask the
/// bundled model for anything again, but its ~0.5 GB stayed resident for the
/// rest of the session because only `delete()` cleared the slot. Leaving the
/// route is the moment to let go of it.
fn bundled_cleanup_runtime_should_unload(previous: &str, next: &str) -> bool {
    previous == llm::bundled_local::PROVIDER_SETTINGS_VALUE
        && next != llm::bundled_local::PROVIDER_SETTINGS_VALUE
}

/// What the Models screen needs to render the bundled cleanup model's row.
fn bundled_cleanup_model_status() -> serde_json::Value {
    let models_root = crate::paths::data_dir()
        .map(|dir| dir.join("Plainsong").join("models"))
        .unwrap_or_default();
    let dir = llm::bundled_local::model_dir(&models_root);
    let missing = llm::bundled_local::untrusted_artifacts(&dir);
    let backend = llm::bundled_local::available_backend();
    serde_json::json!({
        "provider": llm::bundled_local::PROVIDER_SETTINGS_VALUE,
        "modelId": llm::bundled_local::MODEL_ID,
        "displayName": llm::bundled_local::MODEL_DISPLAY_NAME,
        "vendor": llm::bundled_local::MODEL_VENDOR,
        "downloadBytes": llm::bundled_local::total_download_bytes(),
        "bytesOnDisk": llm::bundled_local::bytes_on_disk(&models_root),
        "ready": missing.is_empty(),
        "missingFiles": missing,
        "path": dir.to_string_lossy(),
        // Which backend a cleanup would actually run on, and whether that
        // backend can meet the pre-insert budget. "Downloaded" and "usable"
        // are different questions here: on CPU a 200-word dictation takes
        // 11-13 s against a 6 s budget, so the Models screen has to say so
        // rather than let the user discover it as a recurring warning.
        "backend": backend,
        "backendMeetsBudget": llm::bundled_local::backend_meets_dictation_budget(backend),
        "backendPresent": llm::bundled_local::backend_is_present(backend),
        "residentBytes": llm::bundled_local::RESIDENT_BYTES,
    })
}

fn dictation_provider_uses_local_model(provider: asr::AsrProviderType) -> bool {
    matches!(
        provider,
        asr::AsrProviderType::Whisper
            | asr::AsrProviderType::WhisperCandle
            | asr::AsrProviderType::DistilWhisper
            | asr::AsrProviderType::Moonshine
            | asr::AsrProviderType::Parakeet
            | asr::AsrProviderType::Qwen3Asr
            | asr::AsrProviderType::CohereLocal
    )
}

const DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS: u64 = 45;

struct DictationModelPrewarmTask {
    provider: asr::AsrProviderType,
    model_id: String,
    handle: tokio::task::JoinHandle<()>,
}

#[cfg(not(test))]
static DICTATION_MODEL_PREWARM_TASKS: LazyLock<StdMutex<Vec<DictationModelPrewarmTask>>> =
    LazyLock::new(|| StdMutex::new(Vec::new()));

fn has_matching_model_prewarm(
    tasks: &[DictationModelPrewarmTask],
    provider: asr::AsrProviderType,
    model_id: &str,
) -> bool {
    tasks
        .iter()
        .any(|task| task.provider == provider && task.model_id == model_id)
}

async fn join_background_tasks(tasks: Vec<tokio::task::JoinHandle<()>>) {
    // Local model initializers run through spawn_blocking. Aborting the async
    // wrapper detaches that native work instead of cancelling it, which lets
    // whisper.cpp keep touching global state while shutdown clears its caches.
    // Join the bounded warmup (it already has a 45-second timeout) before any
    // provider cache is released.
    for task in tasks {
        let _ = task.await;
    }
}

async fn acknowledge_dictation_model_warmup<F>(
    model_id: &str,
    warmup: F,
) -> Result<DictationModelWarmState, String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    match tokio::time::timeout(
        Duration::from_secs(DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS),
        warmup,
    )
    .await
    {
        Ok(Ok(())) => Ok(DictationModelWarmState::Ready),
        Ok(Err(error)) => Err(format!(
            "Could not prepare the selected local dictation model '{}': {}",
            model_id, error
        )),
        Err(_) => Err(format!(
            "Preparing the selected local dictation model '{}' exceeded {} seconds. Choose a smaller local model or try again.",
            model_id, DICTATION_MODEL_WARMUP_TIMEOUT_SECONDS
        )),
    }
}

async fn prepare_dictation_model(
    provider: asr::AsrProviderType,
    model_id: &str,
    keep_warm: &str,
) -> Result<DictationModelWarmState, String> {
    if !dictation_provider_uses_local_model(provider) {
        return Ok(DictationModelWarmState::NotRequired);
    }
    if !dictation_keep_warm_enabled(keep_warm) {
        return Ok(DictationModelWarmState::Deferred);
    }

    let provider_runtime = asr::AsrProviderFactory::create_with_model(provider, Some(model_id));
    acknowledge_dictation_model_warmup(model_id, async move {
        provider_runtime
            .prewarm()
            .await
            .map_err(|error| error.to_string())
    })
    .await
}

#[cfg(test)]
fn schedule_dictation_model_prewarm(_transcription: &settings::TranscriptionSettings) {
    // Unit tests exercise startup and settings persistence with the user's
    // real Application Support directory. Loading a Metal model there makes
    // the test binary own native global state and can abort in whisper.cpp's
    // process teardown. Warmup behavior itself is tested deterministically
    // through `acknowledge_dictation_model_warmup`.
}

#[cfg(not(test))]
fn schedule_dictation_model_prewarm(transcription: &settings::TranscriptionSettings) {
    if !dictation_keep_warm_enabled(&transcription.dictation_keep_warm) {
        return;
    }
    let (provider, model_id) =
        resolve_transcription_provider_and_model(transcription, TranscriptionScope::Dictation);
    if !dictation_provider_uses_local_model(provider) {
        return;
    }
    let keep_warm = transcription.dictation_keep_warm.clone();
    let mut tasks = DICTATION_MODEL_PREWARM_TASKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tasks.retain(|existing| !existing.handle.is_finished());
    if has_matching_model_prewarm(&tasks, provider, &model_id) {
        return;
    }
    let task_model_id = model_id.clone();
    let task = tokio::spawn(async move {
        if let Err(error) = prepare_dictation_model(provider, &task_model_id, &keep_warm).await {
            // Startup remains usable so the readiness and model screens can
            // explain or repair the model. A dictation start repeats this
            // acknowledged handshake and surfaces the failure in the HUD.
            tracing::warn!("Background dictation model warmup failed: {}", error);
        }
    });
    tasks.push(DictationModelPrewarmTask {
        provider,
        model_id,
        handle: task,
    });
}

/// Compose the done-phase message for a finished dictation session.
///
/// A session that degraded (an LLM pass that failed or timed out, a command
/// with no text to work on) still reports as done, but the warning describes
/// the *formatting* pass while the outcome describes where the text actually
/// went. Leading with the warning alone used to hide the outcome entirely —
/// so a clipboard-only fallback, or a delivery that failed outright, read as
/// an ordinary success. Say what happened to the text first, then why it is
/// not quite what was asked for.
/// What the delivery step observed, reduced to the terminal `outcome` string
/// the overlay, the audit log and the renderer key on.
struct DictationDeliveryFacts<'a> {
    pasted: bool,
    copied: bool,
    /// The target was observed to take the text (direct Accessibility write),
    /// as opposed to a Cmd+V that was merely dispatched.
    confirmed: bool,
    undo_performed: bool,
    /// The secure-field policy refused delivery: nothing inserted, nothing
    /// on the clipboard. Distinct from `error` so the renderer can say why.
    secure_field_refused: bool,
    has_paste_error: bool,
    /// The outcome already set before delivery ran (an undo-only session,
    /// or nothing at all), kept when delivery reported nothing.
    previous: &'a str,
}

fn resolve_dictation_delivery_outcome(facts: DictationDeliveryFacts<'_>) -> String {
    if facts.pasted {
        if facts.undo_performed {
            "replaced".to_string()
        } else if facts.confirmed {
            "pasted".to_string()
        } else {
            // Dispatched via Cmd+V with no read-back. Claiming a confirmed
            // insert here is what let the app tell users it had typed text
            // into an app that never took it.
            "paste_dispatched".to_string()
        }
    } else if facts.copied {
        if facts.undo_performed {
            "copied_replacement".to_string()
        } else {
            "copied".to_string()
        }
    } else if facts.secure_field_refused {
        dictation_secure_field::SECURE_FIELD_REASON_CODE.to_string()
    } else if facts.has_paste_error {
        "error".to_string()
    } else {
        facts.previous.to_string()
    }
}

fn dictation_done_message(outcome: &str, final_text_is_empty: bool, warnings: &[String]) -> String {
    let outcome_message = match outcome {
        "pasted" | "replaced" => "Inserted into the target app.",
        // Refused on purpose: the focused control is a password or other
        // secure input. Says so, says nothing was copied either, and says
        // where the words are.
        dictation_secure_field::SECURE_FIELD_REASON_CODE => {
            "Not inserted: the field in front is a password or secure input. Plainsong did not insert or copy the words; they are saved in your dictation history."
        }
        // The paste keystroke was sent but nothing reported back that the app
        // took it, so this says what actually happened and leaves the user a
        // next step. The text stays on the clipboard for exactly this case.
        "paste_dispatched" => {
            "Sent to the target app. If nothing appeared, press Cmd+V to paste it."
        }
        "copied" | "copied_replacement" => "Copied to the clipboard and ready to paste.",
        "previewed" => "Ready in Plainsong.",
        "undone" => "Undo applied.",
        "error" => "Could not deliver the text. It is saved in your dictation history.",
        _ if final_text_is_empty => "No speech detected.",
        _ => "Result ready.",
    };

    if warnings.is_empty() {
        outcome_message.to_string()
    } else {
        format!("{} {}", outcome_message, warnings.join(" "))
    }
}

fn should_deliver_dictation_text(delivery_mode: models::DictationDeliveryMode) -> bool {
    delivery_mode == models::DictationDeliveryMode::System
}

fn normalize_dictation_silence_timeout_seconds(value: f32) -> f32 {
    if !value.is_finite() || value <= 0.0 {
        0.0
    } else {
        value.clamp(
            MIN_DICTATION_SILENCE_TIMEOUT_SECONDS,
            MAX_DICTATION_SILENCE_TIMEOUT_SECONDS,
        )
    }
}

/// Resolves the effective silence-auto-stop timeout for a dictation session,
/// applying the hands-free fallback described in the Settings UI: hands-free
/// sessions always auto-stop on silence, even if the user has silence
/// auto-stop disabled (0) for non-hands-free sessions, since hands-free has
/// no other way to end a session besides a second hotkey press.
fn resolve_dictation_auto_stop_silence_timeout_seconds(
    hands_free_enabled: bool,
    configured_silence_timeout_seconds: f32,
) -> f32 {
    if hands_free_enabled && configured_silence_timeout_seconds <= 0.0 {
        HANDS_FREE_DEFAULT_SILENCE_TIMEOUT_SECONDS
    } else {
        configured_silence_timeout_seconds
    }
}

fn normalize_color_scheme_value(_value: &str) -> String {
    // Plainsong ships a single palette; legacy multi-scheme values collapse
    // to "default" (matches the renderer's `theme-schemes.ts`).
    "default".to_string()
}

fn normalize_asr_model_id(provider_type: asr::AsrProviderType, model_id: &str) -> String {
    let trimmed = model_id.trim();
    let candidate = if trimmed.is_empty() {
        provider_type.default_model_id()
    } else {
        trimmed
    };

    if matches!(candidate, "macos_apple_speech" | "windows_sdk_dictation")
        && !matches!(
            provider_type,
            asr::AsrProviderType::MacosAppleSpeech | asr::AsrProviderType::WindowsSdkDictation
        )
    {
        return provider_type.default_model_id().to_string();
    }

    match provider_type {
        // The retired `parakeet-ctc-0.6b` / `parakeet-ctc-1.1b` ids fall through
        // to the v3 default, matching `asr::parakeet::normalize_parakeet_model_id`.
        asr::AsrProviderType::Parakeet => match candidate {
            "parakeet-tdt-0.6b-v3" | "parakeet-tdt-0.6b-v2" => "parakeet-tdt-0.6b-v3".to_string(),
            "parakeet-tdt-ctc-110m" | "parakeet-legacy-110m" => "parakeet-tdt-ctc-110m".to_string(),
            _ => "parakeet-tdt-0.6b-v3".to_string(),
        },
        asr::AsrProviderType::WhisperCandle => "whisper-large-v3-turbo".to_string(),
        asr::AsrProviderType::Moonshine => match candidate {
            "moonshine" | "moonshine-base" => "moonshine-base".to_string(),
            "moonshine-tiny" => "moonshine-tiny".to_string(),
            _ => "moonshine-base".to_string(),
        },
        asr::AsrProviderType::MacosAppleSpeech => "macos_apple_speech".to_string(),
        asr::AsrProviderType::WindowsSdkDictation => "windows_sdk_dictation".to_string(),
        _ => {
            if provider_type
                .model_options()
                .iter()
                .any(|option| option.id == candidate)
            {
                candidate.to_string()
            } else {
                provider_type.default_model_id().to_string()
            }
        }
    }
}

fn normalize_platform_mode(value: &str) -> &'static str {
    match value.trim() {
        "manual" => "manual",
        _ => "auto",
    }
}

fn normalize_platform_fallback_policy(value: &str) -> &'static str {
    match value.trim() {
        "allow_cloud" => "allow_cloud",
        "fail_fast" => "fail_fast",
        _ => "local_only",
    }
}

fn normalize_platform_engine_id(value: &str) -> Option<&'static str> {
    match value.trim() {
        "provider_default" => Some("provider_default"),
        "macos_apple_speech" => Some("macos_apple_speech"),
        // macos_mlx_sidecar was a stub engine with no production runtime
        // behind it (see `asr::platform::mlx_sidecar`) and has been retired;
        // rejecting it here drops it from `manual_engine_priority` on load
        // the same way other retired engine ids are dropped.
        "windows_foundry_local" => Some("windows_foundry_local"),
        "windows_sdk_dictation" => Some("windows_sdk_dictation"),
        _ => None,
    }
}

fn normalize_platform_optimization(settings: &mut settings::PlatformOptimizationSettings) {
    settings.mode = normalize_platform_mode(&settings.mode).to_string();
    settings.fallback_policy =
        normalize_platform_fallback_policy(&settings.fallback_policy).to_string();
    // Apple Speech is exposed only as its own dictation provider. Legacy engine
    // overrides could replace Whisper with Apple Speech and then fall back to
    // Whisper when Apple was unavailable, which made the selected route dishonest.
    settings.macos.apple_native_enabled = false;
    settings.manual_engine_priority = settings
        .manual_engine_priority
        .iter()
        .filter_map(|value| normalize_platform_engine_id(value))
        .filter(|value| *value != "macos_apple_speech")
        .map(ToString::to_string)
        .collect();
    if settings.mode == "manual" && settings.manual_engine_priority.is_empty() {
        settings.mode = "auto".to_string();
    }
}

fn provider_model_map_from_settings(
    transcription: &settings::TranscriptionSettings,
) -> HashMap<asr::AsrProviderType, String> {
    let mut map: HashMap<asr::AsrProviderType, String> = asr::AsrProviderType::all()
        .into_iter()
        .map(|pt| (pt, pt.default_model_id().to_string()))
        .collect();

    for (key, model_id) in &transcription.provider_model_ids {
        if let Some(pt) = asr_provider_from_settings_value(key) {
            let normalized = normalize_asr_model_id(pt, model_id);
            map.insert(pt, normalized);
        }
    }

    if let Some(default_provider) =
        asr_provider_from_settings_value(&transcription.default_provider)
    {
        let normalized = normalize_asr_model_id(default_provider, &transcription.selected_model_id);
        map.insert(default_provider, normalized);
    }

    if let Some(dictation_provider) =
        asr_provider_from_settings_value(&transcription.dictation_provider)
    {
        let normalized =
            normalize_asr_model_id(dictation_provider, &transcription.dictation_model_id);
        map.insert(dictation_provider, normalized);
    }

    if let Some(meeting_provider) =
        asr_provider_from_settings_value(&transcription.meeting_provider)
    {
        let normalized = normalize_asr_model_id(meeting_provider, &transcription.meeting_model_id);
        map.insert(meeting_provider, normalized);
    }

    map
}

fn provider_model_map_to_settings(
    map: &HashMap<asr::AsrProviderType, String>,
) -> HashMap<String, String> {
    map.iter()
        .map(|(pt, model_id)| {
            (
                asr_provider_to_settings_value(*pt).to_string(),
                model_id.clone(),
            )
        })
        .collect()
}

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

/// Sidecar-compatible save_settings: applies normalized settings and emits frontend events.
async fn save_settings_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut settings: settings::Settings,
) -> Result<serde_json::Value, String> {
    let (privileged_privacy, previous_shortcuts) = {
        let manager = state.settings_manager.lock().await;
        (
            manager.settings().privacy.clone(),
            manager.settings().shortcuts.clone(),
        )
    };
    preserve_privileged_privacy_settings(&privileged_privacy, &mut settings.privacy);
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

/// Resolve the on-disk path to the Silero VAD ONNX model, but only when
/// `vad_backend` actually calls for it -- when the energy-threshold backend
/// is selected, skip touching the filesystem/download-manager entirely and
/// return `None`, since `build_vad_gate` never consults it in that case.
///
/// Returns `None` (rather than erroring) if the download manager can't be
/// constructed or the model hasn't been downloaded yet; both are handled,
/// expected cases that `crate::audio::silero_vad::build_vad_gate` already
/// treats as "fall back to energy-threshold".
fn resolve_silero_vad_model_path(
    vad_backend: audio::vad::VadBackendKind,
) -> Option<std::path::PathBuf> {
    if vad_backend != audio::vad::VadBackendKind::Silero {
        return None;
    }
    let manager = download::DownloadManager::new().ok()?;
    if !manager.is_silero_vad_model_downloaded() {
        return None;
    }
    Some(manager.silero_vad_model_path())
}

/// Sidecar-compatible start_dictation: simplified version that emits events via SidecarHandle.
/// Full overlay sync and tray updates are handled by Electron.
/// Handles captured under the audio lock to drive the UI-only streaming-partial
/// task: (partial sample buffer, is-dictating flag, capture sample rate).
type PartialTaskHandles = (
    Arc<std::sync::Mutex<audio::DictationPartialBuffer>>,
    Arc<AtomicBool>,
    u32,
);

async fn start_dictation_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut options: models::DictationStartOptions,
) -> Result<u64, String> {
    let mut settings_snapshot = {
        let sm = state.settings_manager.lock().await;
        sm.settings().clone()
    };
    // A per-mode binding runs this one session under its mode; the snapshot
    // is what every mode-dependent decision below reads, and the options are
    // stored as the session record so stop applies the same override.
    apply_dictation_session_mode_override(&mut settings_snapshot, &mut options);
    let requested_selection = resolve_transcription_provider_and_model(
        &settings_snapshot.transcription,
        TranscriptionScope::Dictation,
    );

    let (
        dictation_provider,
        dictation_model_id,
        resolved_route_preference,
        resolved_hosting,
        provider_warning,
    ) = resolve_ready_dictation_selection(
        state,
        &settings_snapshot.transcription,
        options.route_preference.as_deref(),
        settings_snapshot.privacy.remote_processing_enabled,
    )
    .await?;

    if let Some(warning) = provider_warning.as_deref() {
        handle.emit_event("asr-provider-warning", warning.to_string());
    }

    let requested_provider_value =
        asr_provider_to_settings_value(requested_selection.0).to_string();
    let requested_model_id_value = requested_selection.1.clone();
    let actual_provider_value = asr_provider_to_settings_value(dictation_provider).to_string();
    let actual_model_id_value = dictation_model_id.clone();

    options.requested_provider = Some(requested_provider_value.clone());
    options.requested_model_id = Some(requested_model_id_value.clone());
    options.actual_provider = Some(actual_provider_value.clone());
    options.actual_model_id = Some(actual_model_id_value.clone());
    options.route_preference =
        Some(dictation_route_preference_to_settings_value(resolved_route_preference).to_string());
    options.resolved_route = Some(format!(
        "{}/{}",
        asr_provider_to_settings_value(dictation_provider),
        dictation_model_id
    ));
    options.provider_model_label = Some(format!(
        "{} · {}",
        dictation_provider.display_name(),
        dictation_model_id
    ));
    options.resolved_hosting =
        Some(hosting_environment_to_settings_value(resolved_hosting).to_string());
    capture_sidecar_dictation_start_context(state, &settings_snapshot, &mut options).await;

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Idle {
            return Err("Dictation is already active".to_string());
        }
        let has_mic = {
            let audio = state.audio_capture.lock().await;
            audio.has_microphone_input()
        };
        if !has_mic {
            return Err(
                "No microphone available. Please connect a microphone and grant permission."
                    .to_string(),
            );
        }
        *runtime_state = DictationSessionState::Starting;
    }

    let session_started_at_ms = chrono::Utc::now().timestamp_millis();
    let session_id = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.next_session_id += 1;
        tracker.active_session_id = Some(tracker.next_session_id);
        // A new session never inherits the previous session's stop claim.
        tracker.stopping_session_id = None;
        tracker.started_at = Some(std::time::Instant::now());
        tracker.started_at_epoch_ms = Some(session_started_at_ms);
        tracker.startup_latency_ms = None;
        tracker.acknowledged_at_epoch_ms = None;
        tracker.capture_ready_at_epoch_ms = None;
        tracker.first_stable_partial_at_epoch_ms = None;
        tracker.stop_requested_at = None;
        tracker.final_transcript_at_epoch_ms = None;
        tracker.insertion_completed_at_epoch_ms = None;
        tracker.insertion_mode_at_start = Some(DictationInsertionMode::from_settings_value(
            &settings_snapshot.transcription.dictation_insertion_mode,
        ));
        tracker.copy_to_clipboard_at_start =
            Some(settings_snapshot.transcription.dictation_copy_to_clipboard);
        tracker.next_session_id
    };

    {
        let mut active_options = state.dictation_start_options.lock().await;
        *active_options = options.clone();
    }

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "preparing".to_string();
        overlay.dismissed = false;
        overlay.session_id = Some(session_id);
        overlay.started_at_ms = Some(session_started_at_ms);
        overlay.message = Some("Loading the selected dictation model".to_string());
        overlay.dictation_provider =
            Some(asr_provider_to_settings_value(dictation_provider).to_string());
        overlay.dictation_model_id = Some(dictation_model_id.clone());
        overlay.model_readiness = Some("loading".to_string());
        overlay.capture_ready = false;
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "preparing",
            "sessionId": session_id,
            "startedAtMs": session_started_at_ms,
            "message": "Loading the selected dictation model",
            "dictationProvider": asr_provider_to_settings_value(dictation_provider),
            "dictationModelId": dictation_model_id,
            "modelReadiness": "loading",
            "captureReady": false,
        }),
    );
    {
        let mut tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id == Some(session_id) {
            tracker.acknowledged_at_epoch_ms = Some(chrono::Utc::now().timestamp_millis());
        }
    }
    handle.window_command("show-dictation-overlay", &serde_json::Value::Null);

    state
        .asr_manager
        .set_provider_model_id(dictation_provider, dictation_model_id.clone())
        .await;

    let startup_result: Result<DictationModelWarmState, String> = async {
        #[cfg(target_os = "macos")]
        ensure_microphone_permission(
            settings_snapshot
                .transcription
                .dictation_auto_request_permissions,
        )
        .map_err(|error| format!("Microphone permission is not ready. {}", error))?;

        #[cfg(target_os = "macos")]
        if dictation_provider == asr::AsrProviderType::MacosAppleSpeech {
            crate::asr::platform::macos_speech::ensure_speech_authorized(
                settings_snapshot
                    .transcription
                    .dictation_auto_request_permissions,
            )
            .map_err(|error| {
                format!(
                    "Apple Native Speech is selected for dictation, but speech recognition permission is not ready. {}",
                    error
                )
            })?;
        }

        prepare_dictation_model(
            dictation_provider,
            &dictation_model_id,
            &settings_snapshot.transcription.dictation_keep_warm,
        )
        .await
    }
    .await;

    let model_warm_state = match startup_result {
        Ok(model_warm_state) => model_warm_state,
        Err(error) => {
            reset_dictation_session_runtime(
                &state.dictation_runtime_state,
                &state.dictation_session_tracker,
                &state.dictation_start_options,
            )
            .await;
            if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                overlay.phase = "error".to_string();
                overlay.message = Some(error.clone());
                overlay.model_readiness = Some("error".to_string());
                overlay.capture_ready = false;
            }
            handle.emit_event(
                "dictation-state-changed",
                serde_json::json!({
                    "phase": "error",
                    "sessionId": session_id,
                    "message": error,
                    "modelReadiness": "error",
                    "captureReady": false,
                }),
            );
            return Err(error);
        }
    };

    // A cancellation can land while a cold model is loading. Do not let the
    // completed warmup resurrect that cancelled session and open the mic.
    if state
        .dictation_session_tracker
        .lock()
        .await
        .active_session_id
        != Some(session_id)
    {
        return Err("Dictation start was cancelled".to_string());
    }
    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        if *runtime_state != DictationSessionState::Starting {
            return Err("Dictation start was cancelled".to_string());
        }
        *runtime_state = DictationSessionState::Primed;
    }

    let primed_message = match model_warm_state {
        DictationModelWarmState::Ready => "Local model ready. Opening the microphone.",
        DictationModelWarmState::Deferred => {
            "Opening the microphone. The local model will load after capture."
        }
        DictationModelWarmState::NotRequired => "Opening the microphone.",
    };

    // Update overlay state so get_dictation_overlay_state returns the correct snapshot.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "primed".to_string();
        overlay.dismissed = false;
        overlay.session_id = Some(session_id);
        overlay.started_at_ms = Some(session_started_at_ms);
        overlay.message = Some(primed_message.to_string());
        overlay.model_readiness = Some(model_warm_state.as_event_value().to_string());
        overlay.capture_ready = false;
        overlay.dictation_provider =
            Some(asr_provider_to_settings_value(dictation_provider).to_string());
        overlay.dictation_model_id = Some(dictation_model_id.clone());
        overlay.requested_provider = Some(requested_provider_value.clone());
        overlay.actual_provider = Some(actual_provider_value.clone());
        overlay.requested_model_id = Some(requested_model_id_value.clone());
        overlay.actual_model_id = Some(actual_model_id_value.clone());
        overlay.fallback_reason = provider_warning.clone();
        overlay.target_app = options.context_app_name.clone();
        overlay.resolved_mode_preset = options.resolved_mode_preset.clone();
        overlay.resolved_custom_mode_id = options.resolved_custom_mode_id.clone();
        overlay.resolved_mode_label = options.resolved_mode_label.clone();
        overlay.context_source = Some(options.context_source.clone());
        overlay.insertion_mode = Some(
            normalize_dictation_insertion_mode(
                &settings_snapshot.transcription.dictation_insertion_mode,
            )
            .to_string(),
        );
        overlay.app_target = options.context_app_name.clone();
        overlay.activation_matcher = options.activation_matcher.clone();
        overlay.requested_route = options.route_preference.clone();
        overlay.resolved_route = options.resolved_route.clone();
        overlay.provider_model_label = options.provider_model_label.clone();
        overlay.dictation_route_preference = options.route_preference.clone();
        overlay.dictation_resolved_hosting = options.resolved_hosting.clone();
    }

    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "primed",
            "sessionId": session_id,
            "startedAtMs": session_started_at_ms,
            "message": primed_message,
            "dictationProvider": asr_provider_to_settings_value(dictation_provider),
            "dictationModelId": dictation_model_id,
            "requestedProvider": requested_provider_value,
            "actualProvider": actual_provider_value,
            "requestedModelId": requested_model_id_value,
            "actualModelId": actual_model_id_value,
            "fallbackReason": provider_warning,
            "targetApp": options.context_app_name,
            "resolvedModePreset": options.resolved_mode_preset,
            "resolvedCustomModeId": options.resolved_custom_mode_id,
            "resolvedModeLabel": options.resolved_mode_label,
            "contextSource": options.context_source,
            "insertionMode": normalize_dictation_insertion_mode(&settings_snapshot.transcription.dictation_insertion_mode),
            "appTarget": options.context_app_name,
            "activationMatcher": options.activation_matcher,
            "requestedRoute": options.route_preference,
            "resolvedRoute": options.resolved_route,
            "providerModelLabel": options.provider_model_label,
            "dictationRoutePreference": options.route_preference,
            "dictationResolvedHosting": options.resolved_hosting,
            "modelReadiness": model_warm_state.as_event_value(),
            "captureReady": false,
        }),
    );

    // Tell Electron to show the dictation overlay window.
    handle.window_command("show-dictation-overlay", &serde_json::Value::Null);

    let preferred_input_device = {
        let sm = state.settings_manager.lock().await;
        let settings = sm.settings();
        if settings.audio.dictation_input_override_enabled {
            settings.audio.dictation_input_device.clone()
        } else {
            settings.audio.preferred_input_device.clone()
        }
    };

    // Which engine draws the live preview, if any. The re-decode preview is
    // UI-only and only runs for local providers (cloud providers must not be
    // hit per-tick); Apple Speech is excluded because that generic mechanism
    // repeatedly batch-decodes the growing WAV buffer, which would launch a new
    // helper process about every 700 ms. Streaming replaces the *preview*
    // only -- the inserted text is the batch decode either way.
    let live_preview_language = options.language_override.clone();
    let live_preview_engine = resolve_dictation_live_preview_engine(DictationLivePreviewInputs {
        live_preview_enabled: settings_snapshot
            .transcription
            .dictation_live_preview_enabled,
        engine_setting: &settings_snapshot
            .transcription
            .dictation_live_preview_engine,
        provider_supports_redecode: provider_supports_generic_live_preview(dictation_provider),
        streaming_compiled_in: streaming_live_preview_compiled_in(),
        streaming_model_ready: streaming_live_preview_model_ready(),
        streaming_language_supported: streaming_live_preview_supports_language(
            live_preview_language.as_deref(),
        ),
    });
    // Both engines read the same UI-only sample buffer, so the capture callback
    // fills it for either.
    let streaming_partials_enabled = live_preview_engine != DictationLivePreviewEngine::Off;

    // Auto-stop after sustained silence: gated on `dictation_silence_timeout_seconds`
    // (0 = disabled, matching the field's existing "0 disables" contract already
    // used by the settings UI/normalizer). Works regardless of activation mode
    // (toggle, push-to-talk, or hands-free) since it just stops the session the
    // same way a manual stop would.
    //
    // Hands-free is a special case: it starts the session automatically on
    // detected speech, so if silence auto-stop is left disabled it would never
    // stop on its own. The Settings UI ("Hands-free guide") promises a 1.8s
    // fallback in that case, so apply it here.
    let effective_silence_timeout_seconds = resolve_dictation_auto_stop_silence_timeout_seconds(
        settings_snapshot.transcription.dictation_hands_free_enabled,
        settings_snapshot
            .transcription
            .dictation_silence_timeout_seconds,
    );
    let vad_backend = audio::vad::VadBackendKind::from_settings_str(
        &settings_snapshot.transcription.dictation_vad_backend,
    );
    let auto_stop_config = audio::DictationAutoStopConfig {
        enabled: effective_silence_timeout_seconds > 0.0,
        silence_timeout_seconds: effective_silence_timeout_seconds,
        vad_backend,
        silero_model_path: resolve_silero_vad_model_path(vad_backend),
    };

    // Handles captured under the audio lock when capture starts successfully, so
    // the partial-decode task can be spawned after the lock is released.
    let mut partial_task_handles: Option<PartialTaskHandles> = None;

    {
        let mut audio = state.audio_capture.lock().await;
        if *state.dictation_runtime_state.lock().await != DictationSessionState::Primed {
            return Err("Dictation start was cancelled".to_string());
        }
        audio.set_streaming_partials_enabled(streaming_partials_enabled);
        match audio.start_dictation(
            preferred_input_device.as_ref(),
            session_id,
            auto_stop_config,
            Some(handle.clone()),
            // Only a start the hands-free monitor itself asked for may inherit
            // the monitor's pre-roll. `dispatch_command` stops the monitor
            // immediately before every start, so the ring is always fresh
            // enough to pass `take_dictation_pre_roll`'s age guard — this flag
            // is what keeps a hotkey press from picking it up.
            options.hands_free_trigger,
        ) {
            Ok(resolved_input) => {
                if let Some(advisory) = resolved_input.advisory.as_deref() {
                    handle.emit_event("audio-input-advisory", advisory.to_string());
                }
                if streaming_partials_enabled {
                    partial_task_handles = Some((
                        audio.dictation_partial_buffer_handle(),
                        audio.is_dictating_handle(),
                        audio.dictation_sample_rate(),
                    ));
                }
            }
            Err(e) => {
                let mut runtime_state = state.dictation_runtime_state.lock().await;
                *runtime_state = DictationSessionState::Idle;
                drop(runtime_state);
                let mut tracker = state.dictation_session_tracker.lock().await;
                if tracker.active_session_id == Some(session_id) {
                    tracker.active_session_id = None;
                    tracker.stopping_session_id = None;
                }
                if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                    *overlay = DictationOverlayState::default();
                }
                handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
                return Err(format!("Failed to start audio capture: {}", e));
            }
        }
    }

    // Spawn the UI-only live-preview task. Both engines emit live-preview text
    // and NEITHER feeds the final transcript: the only thing they write is a
    // `partialText` field on `dictation-state-changed`. Best-effort; they
    // swallow their own errors and stop when dictation does.
    if let Some((partial_buffer, is_dictating, sample_rate)) = partial_task_handles.clone() {
        if live_preview_engine == DictationLivePreviewEngine::Streaming {
            // Signal and abort any preview still in the slot *before* spawning
            // this one: the new task waits for the single engine permit, and
            // the old one only releases it once its recognizer is dropped.
            {
                let mut slot = state.dictation_live_preview.lock().await;
                if let Some(previous) = slot.take() {
                    previous
                        .stop
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    previous.task.abort();
                }
            }
            // The streaming preview is held in AppState rather than detached,
            // because the stop path has to be able to close the recognizer
            // before the batch decode that produces the inserted text starts.
            let control = spawn_streaming_live_preview(
                Arc::clone(&state.dictation_session_tracker),
                handle.clone(),
                session_id,
                partial_buffer,
                is_dictating,
                sample_rate,
                live_preview_language.clone(),
            );
            state.dictation_live_preview.lock().await.replace(control);
        }
    }
    if let Some((partial_buffer, is_dictating, sample_rate)) =
        partial_task_handles.filter(|_| live_preview_engine == DictationLivePreviewEngine::Redecode)
    {
        let asr_manager = Arc::clone(&state.asr_manager);
        let session_tracker = Arc::clone(&state.dictation_session_tracker);
        let provider = dictation_provider;
        let model_id = dictation_model_id.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            let mut last_decoded_total_samples: u64 = 0;
            let mut last_decode_finished_at = std::time::Instant::now();
            let mut last_emitted_text = String::new();
            while is_dictating.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(DICTATION_PARTIAL_POLL_MS)).await;

                // Stop promptly if dictation ended or a NEWER session started.
                // Gating on the monotonic active session id (not the shared
                // is_dictating flag, which a rapid stop->restart flips back to
                // true) prevents a stale in-flight task from emitting a
                // wrong-session partial that would disrupt the new session's UI.
                if session_tracker.lock().await.active_session_id != Some(session_id) {
                    break;
                }

                let (snapshot, total_samples) = {
                    partial_buffer
                        .lock()
                        .map(|buffer| (buffer.samples.clone(), buffer.total_samples))
                        .unwrap_or_default()
                };

                if !partial_should_decode(
                    total_samples,
                    last_decoded_total_samples,
                    sample_rate,
                    last_decode_finished_at.elapsed().as_millis() as u64,
                ) {
                    continue;
                }

                // Only recent audio may trigger another preview. Re-checking
                // the entire sliding window let old speech repeatedly decode
                // while the user was currently silent.
                if !partial_recent_window_has_speech(&snapshot, sample_rate) {
                    continue;
                }

                if !is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                    || session_tracker.lock().await.active_session_id != Some(session_id)
                {
                    break;
                }

                let bytes = match mono_samples_to_wav_bytes(&snapshot, sample_rate) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        tracing::debug!("Streaming partial wav encode failed: {}", error);
                        continue;
                    }
                };

                let result = asr_manager
                    .transcribe_bytes_for_dictation(provider, &bytes, Some(&model_id))
                    .await;
                last_decoded_total_samples = total_samples;
                last_decode_finished_at = std::time::Instant::now();

                match result {
                    Ok(transcription) => {
                        let text = transcription.text.trim().to_string();
                        // Re-check the live session id right before emit: the
                        // decode may have outlived the session it was started for.
                        let still_current = is_dictating.load(std::sync::atomic::Ordering::SeqCst)
                            && session_tracker.lock().await.active_session_id == Some(session_id);
                        if still_current && !text.is_empty() && text != last_emitted_text {
                            {
                                let mut tracker = session_tracker.lock().await;
                                if tracker.active_session_id == Some(session_id)
                                    && tracker.first_stable_partial_at_epoch_ms.is_none()
                                {
                                    tracker.first_stable_partial_at_epoch_ms =
                                        Some(chrono::Utc::now().timestamp_millis());
                                }
                            }
                            handle.emit_event(
                                "dictation-state-changed",
                                serde_json::json!({
                                    "phase": "recording",
                                    "sessionId": session_id,
                                    "partialText": text,
                                }),
                            );
                            last_emitted_text = text;
                        }
                    }
                    Err(error) => {
                        tracing::debug!("Streaming partial decode failed: {}", error);
                    }
                }
            }
        });
    }

    {
        let mut runtime_state = state.dictation_runtime_state.lock().await;
        *runtime_state = DictationSessionState::Recording;
    }
    {
        let mut tracker = state.dictation_session_tracker.lock().await;
        if tracker.active_session_id == Some(session_id) && tracker.startup_latency_ms.is_none() {
            tracker.startup_latency_ms = tracker.started_at.map(|started_at| {
                started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
            });
            tracker.capture_ready_at_epoch_ms = Some(chrono::Utc::now().timestamp_millis());
        }
    }

    // Update overlay state to "recording" phase (matches frontend DictationPhase type).
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "recording".to_string();
        overlay.message = Some("Listening".to_string());
        overlay.capture_ready = true;
    }

    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "recording",
            "sessionId": session_id,
            "startedAtMs": session_started_at_ms,
            "dictationProvider": asr_provider_to_settings_value(dictation_provider),
            "dictationModelId": dictation_model_id,
            "requestedProvider": asr_provider_to_settings_value(requested_selection.0),
            "actualProvider": asr_provider_to_settings_value(dictation_provider),
            "requestedModelId": requested_selection.1,
            "actualModelId": dictation_model_id,
            "targetApp": options.context_app_name,
            "resolvedModePreset": options.resolved_mode_preset,
            "resolvedCustomModeId": options.resolved_custom_mode_id,
            "resolvedModeLabel": options.resolved_mode_label,
            "contextSource": options.context_source,
            "insertionMode": normalize_dictation_insertion_mode(&settings_snapshot.transcription.dictation_insertion_mode),
            "appTarget": options.context_app_name,
            "activationMatcher": options.activation_matcher,
            "requestedRoute": options.route_preference,
            "resolvedRoute": options.resolved_route,
            "providerModelLabel": options.provider_model_label,
            "dictationRoutePreference": options.route_preference,
            "dictationResolvedHosting": options.resolved_hosting,
            "modelReadiness": model_warm_state.as_event_value(),
            "captureReady": true,
        }),
    );

    Ok(session_id)
}

/// Drop every piece of per-session dictation state, so the next hotkey press
/// starts a fresh session instead of stopping one that no longer exists.
///
/// Takes the individual handles rather than `&AppState` so it can be unit
/// tested without a database, audio device, or ASR manager.
async fn reset_dictation_session_runtime(
    runtime_state: &Mutex<DictationSessionState>,
    session_tracker: &Mutex<DictationSessionTracker>,
    start_options: &Mutex<models::DictationStartOptions>,
) {
    {
        let mut runtime_state = runtime_state.lock().await;
        *runtime_state = DictationSessionState::Idle;
    }
    {
        let mut tracker = session_tracker.lock().await;
        tracker.active_session_id = None;
        tracker.stopping_session_id = None;
        tracker.started_at = None;
        tracker.started_at_epoch_ms = None;
        tracker.startup_latency_ms = None;
        tracker.acknowledged_at_epoch_ms = None;
        tracker.capture_ready_at_epoch_ms = None;
        tracker.first_stable_partial_at_epoch_ms = None;
        tracker.stop_requested_at = None;
        tracker.final_transcript_at_epoch_ms = None;
        tracker.insertion_completed_at_epoch_ms = None;
    }
    {
        let mut active_options = start_options.lock().await;
        *active_options = models::DictationStartOptions::default();
    }
}

/// Session metadata every terminal dictation-stop error event carries.
/// Captured once so each failure site reports the same shape.
struct DictationStopFailureContext {
    session_id: u64,
    requested_provider: &'static str,
    actual_provider: &'static str,
    requested_model_id: Option<String>,
    actual_model_id: Option<String>,
    app_target: Option<String>,
    insertion_mode: String,
    resolved_route: Option<String>,
    route_preference: Option<String>,
}

/// The one terminal error path for `stop_dictation_for_sidecar`.
///
/// Every failure after the active session is resolved must come through here.
/// An early return that skips it leaves `dictation_runtime_state` on
/// `Recording` and never emits a terminal phase, so Electron's mirrored phase
/// stays "stopping", the hotkey resolves to "ignore", Escape (which only
/// cancels from a live phase) has nothing to act on, and dictation is dead
/// until the app is restarted. Returns the message to hand back as `Err`.
async fn fail_dictation_stop(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    context: &DictationStopFailureContext,
    fallback_reason: Option<String>,
    message: String,
) -> String {
    // Every terminal stop failure comes through here, so this is where a
    // preview that outlived its session is guaranteed to be closed.
    stop_dictation_live_preview(state).await;
    reset_dictation_session_runtime(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
    )
    .await;

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "error".to_string();
        overlay.message = Some(message.clone());
        overlay.requested_provider = Some(context.requested_provider.to_string());
        overlay.actual_provider = Some(context.actual_provider.to_string());
        overlay.requested_model_id = context.requested_model_id.clone();
        overlay.actual_model_id = context.actual_model_id.clone();
        overlay.fallback_reason = fallback_reason.clone();
        overlay.target_app = context.app_target.clone();
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "error",
            "sessionId": context.session_id,
            "message": message,
            "requestedProvider": context.requested_provider,
            "actualProvider": context.actual_provider,
            "requestedModelId": context.requested_model_id,
            "actualModelId": context.actual_model_id,
            "fallbackReason": fallback_reason,
            "targetApp": context.app_target,
            "insertionMode": context.insertion_mode,
            "resolvedRoute": context.resolved_route,
            "routePreference": context.route_preference,
        }),
    );

    schedule_dictation_overlay_idle_reset(
        state,
        handle,
        context.session_id,
        "error",
        DICTATION_IDLE_RESET_ERROR_MS,
    );

    message
}

/// Remember a completed result for the re-paste/re-copy recovery hotkeys and
/// the menu-bar menu. Empty results are not worth offering to re-paste.
fn record_recent_dictation_result(
    state: &AppState,
    text: &str,
    app_target: Option<&str>,
    app_bundle_id: Option<&str>,
) {
    if text.trim().is_empty() {
        return;
    }

    let Ok(mut results) = state.recent_dictation_results.lock() else {
        return;
    };
    push_recent_dictation_result(
        &mut results,
        RecentDictationResult {
            text: text.to_string(),
            app_target: app_target.map(str::to_string),
            app_bundle_id: app_bundle_id.map(str::to_string),
            at_ms: chrono::Utc::now().timestamp_millis(),
        },
    );
}

/// Newest first, capped at [`RECENT_DICTATION_RESULT_LIMIT`]. Split out from
/// the state-holding caller so the ordering and the cap are testable without
/// standing up an `AppState`.
fn push_recent_dictation_result(
    results: &mut Vec<RecentDictationResult>,
    candidate: RecentDictationResult,
) {
    if candidate.text.trim().is_empty() {
        return;
    }
    results.insert(0, candidate);
    results.truncate(RECENT_DICTATION_RESULT_LIMIT);
}

/// Where a re-paste should land: whatever is frontmost *now*, never the app the
/// original session targeted.
///
/// The recovery hotkey exists because the first insert went somewhere the user
/// did not want, so by the time it is pressed the frontmost app is usually a
/// different one — that is the whole point of the path. Replaying the stored
/// target would send `reactivate_target_application` off to `open -b <bundle>`,
/// which raises the app the user just left (and can relaunch one they have
/// since quit, since nothing expires `recent_dictation_results`) and inserts
/// there instead of at their caret. Re-resolving instead of passing `None`
/// keeps the frontmost-app logging and the self/transient filtering in
/// `sanitize_dictation_target` intact.
fn resolve_recent_dictation_repaste_target() -> (Option<String>, Option<String>) {
    #[cfg(target_os = "macos")]
    {
        let (app_name, app_bundle_id, _) = capture_hotkey_target_context(false);
        (app_name, app_bundle_id)
    }

    #[cfg(not(target_os = "macos"))]
    {
        (None, None)
    }
}

/// Re-insert (or just re-copy) one of the recent results. `index` defaults to
/// the newest, which is what both recovery hotkeys bind to.
fn reuse_recent_dictation_result(
    state: &AppState,
    params: &serde_json::Value,
    paste: bool,
) -> Result<serde_json::Value, String> {
    let index = params
        .get("index")
        .and_then(|value| value.as_u64())
        .unwrap_or(0) as usize;
    let Some(result) = recent_dictation_result_at(state, index) else {
        return Err("No recent dictation result is available to reuse.".to_string());
    };

    if !paste {
        copy_to_clipboard(&result.text)?;
        return Ok(serde_json::json!({ "pasted": false, "copied": true }));
    }

    let (target_app, target_app_bundle_id) = resolve_recent_dictation_repaste_target();
    let outcome = paste_text_systemwide(
        &state.accessibility_trust_observed,
        &result.text,
        true,
        target_app.as_deref(),
        target_app_bundle_id.as_deref(),
    );
    if !outcome.pasted && !outcome.copied {
        return Err(outcome
            .error
            .unwrap_or_else(|| "Could not re-insert the last dictation result.".to_string()));
    }
    Ok(serde_json::json!({
        "pasted": outcome.pasted,
        "copied": outcome.copied,
        "error": outcome.error,
    }))
}

fn recent_dictation_result_at(state: &AppState, index: usize) -> Option<RecentDictationResult> {
    state
        .recent_dictation_results
        .lock()
        .ok()
        .and_then(|results| results.get(index).cloned())
}

/// Sidecar-compatible stop_dictation.
///
/// `expected_session_id`, when provided, scopes the stop to a specific
/// session: if the currently active session differs (e.g. a delayed VAD
/// auto-stop for session A arriving after session B already started), the
/// stop is rejected without touching any state, so a stale stop can never
/// tear down a session it doesn't own.
///
/// `stop_gesture_epoch_ms`, when the caller supplies it, is the epoch ms of
/// the real client-side stop gesture (hotkey release, hands-free toggle,
/// etc.) as observed by Electron -- see `dictation-shortcut-controller.ts`,
/// which captures it before any `invoke` await. Absent that (an older
/// caller, or a stop path with no discrete client gesture), the timing
/// record's zero point honestly falls back to when this handler itself
/// observed the stop, which is measurably later than the real gesture by
/// whatever the Electron-to-sidecar IPC hop costs.
async fn stop_dictation_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    stop_reason: &str,
    expected_session_id: Option<u64>,
    stop_gesture_epoch_ms: Option<i64>,
) -> Result<String, String> {
    // Single `Instant`, captured once, that every stage of the timing record
    // below measures elapsed time from. Each stage used to re-lock
    // `dictation_session_tracker` just to read `stop_requested_at` back out
    // -- extra lock traffic bought nothing (the value never changes once set
    // a few lines down), one of those locks sat inside the very insertion
    // window it was measuring, and reading it back through a lock left a
    // window where a concurrent reset (`force_stop_dictation`, or a second
    // stop racing this one) could clear `stop_requested_at` mid-flight and
    // silently drop a stage's timing. A local `Instant` is `Copy`, cannot be
    // reset out from under this function, and costs nothing to read.
    let stop_signal_instant = std::time::Instant::now();

    // Claim the session atomically. Reading the active id and then re-taking
    // the lock later leaves a window where a second stop passes the same
    // checks; both would then run audio finalization and the loser would reset
    // the tracker, throwing away audio the winner had already captured.
    let session_id = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        let active = tracker
            .active_session_id
            .ok_or_else(|| "No active dictation session to stop".to_string())?;

        if let Some(expected) = expected_session_id {
            if expected != active {
                return Err(format!(
                    "Stale stop request for dictation session {} ignored (active session is {})",
                    expected, active
                ));
            }
        }

        if tracker.stopping_session_id == Some(active) {
            return Err(format!(
                "Dictation session {} is already stopping; ignoring duplicate stop",
                active
            ));
        }

        tracker.stopping_session_id = Some(active);
        tracker.stop_requested_at = Some(stop_signal_instant);
        active
    };
    // Epoch-ms zero point for the `DictationTimingRecord` below (every
    // *elapsed* field is measured from `stop_signal_instant` above, not
    // recomputed from this -- this is only for absolute-timestamp
    // reporting). Honestly named: absent a real client gesture epoch, all
    // this sidecar actually knows is when its own stop-command handler ran,
    // which is not the same moment as the user's hotkey release -- see the
    // function doc above.
    let stop_command_received_at_epoch_ms =
        stop_gesture_epoch_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    let mut dictation_options = state.dictation_start_options.lock().await.clone();
    let mut settings_snapshot = {
        let sm = state.settings_manager.lock().await;
        sm.settings().clone()
    };
    // Same per-session mode override the start applied, so the format prompt,
    // translate flag and history record describe the mode this session
    // actually ran under rather than whatever is selected in Settings now.
    apply_dictation_session_mode_override(&mut settings_snapshot, &mut dictation_options);
    let fallback_provider_type = {
        resolve_transcription_provider_and_model(
            &settings_snapshot.transcription,
            TranscriptionScope::Dictation,
        )
        .0
    };
    let requested_provider_type = dictation_options
        .requested_provider
        .as_deref()
        .and_then(asr_provider_from_settings_value)
        .unwrap_or(fallback_provider_type);
    let provider_type = dictation_options
        .actual_provider
        .as_deref()
        .and_then(asr_provider_from_settings_value)
        .unwrap_or(requested_provider_type);
    let requested_model_id = dictation_options.requested_model_id.clone();
    let actual_model_id = dictation_options
        .actual_model_id
        .clone()
        .or_else(|| requested_model_id.clone());
    let app_target = dictation_options.context_app_name.clone();
    let app_bundle_id = dictation_options.context_app_bundle_id.clone();
    let preview_only = !should_deliver_dictation_text(dictation_options.delivery_mode);
    let requested_insertion_mode = if preview_only {
        "preview".to_string()
    } else {
        tracker_insertion_mode(state).await
    };
    // From here on the session is owned: every exit path must be either the
    // terminal "done" emit at the bottom or `fail_dictation_stop`.
    let failure_context = DictationStopFailureContext {
        session_id,
        requested_provider: asr_provider_to_settings_value(requested_provider_type),
        actual_provider: asr_provider_to_settings_value(provider_type),
        requested_model_id: requested_model_id.clone(),
        actual_model_id: actual_model_id.clone(),
        app_target: app_target.clone(),
        insertion_mode: requested_insertion_mode.clone(),
        resolved_route: dictation_options.resolved_route.clone(),
        route_preference: dictation_options.route_preference.clone(),
    };
    let mut warnings: Vec<String> = Vec::new();

    if let Some(model_id) = actual_model_id.as_ref() {
        state
            .asr_manager
            .set_provider_model_id(provider_type, model_id.clone())
            .await;
    }

    // Emit stopping phase so the UI shows feedback immediately.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "stopping".to_string();
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "stopping",
            "sessionId": session_id,
            "stopReason": stop_reason,
            "resolvedModePreset": dictation_options.resolved_mode_preset,
            "resolvedCustomModeId": dictation_options.resolved_custom_mode_id,
            "resolvedModeLabel": dictation_options.resolved_mode_label,
            "contextSource": dictation_options.context_source,
            "insertionMode": requested_insertion_mode,
            "appTarget": app_target,
            "activationMatcher": dictation_options.activation_matcher,
            "requestedRoute": dictation_options.route_preference,
            "resolvedRoute": dictation_options.resolved_route,
            "providerModelLabel": dictation_options.provider_model_label,
            "dictationRoutePreference": dictation_options.route_preference,
            "dictationResolvedHosting": dictation_options.resolved_hosting,
        }),
    );

    // Deliberate extra recording so the speaker's final consonant lands (see
    // `DICTATION_STOP_CAPTURE_TAIL_MS`). It is awaited here, *before* taking the
    // capture mutex: as a blocking sleep inside `stop_dictation` it held the
    // async `audio_capture` lock and parked a tokio worker for its whole
    // duration. Waiting first preserves the ordering the tail depends on --
    // capture is still live and `is_dictating` is still true.
    tokio::time::sleep(Duration::from_millis(
        crate::audio::DICTATION_STOP_CAPTURE_TAIL_MS,
    ))
    .await;

    let (audio_bytes, hit_max_duration) = {
        let mut audio = state.audio_capture.lock().await;
        let hit_max_duration = audio.dictation_hit_max_duration();
        match audio.stop_dictation() {
            Ok(audio_bytes) => (audio_bytes, hit_max_duration),
            Err(error) => {
                return Err(fail_dictation_stop(
                    state,
                    handle,
                    &failure_context,
                    None,
                    format!("Failed to stop dictation audio: {}", error),
                )
                .await);
            }
        }
    };
    // Put the live preview down before anything asks the GPU for the final
    // result. Capture has ended, so the preview has nothing left to show, and
    // the streaming recognizer holds its model's compute lease until its
    // session is closed -- which this awaits. The preview never fed the
    // transcript; this only stops it competing with the decode that does.
    stop_dictation_live_preview(state).await;

    let audio_finalized_ms = Some(
        stop_signal_instant
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64,
    );
    if hit_max_duration {
        // The session was ended by the length ceiling, not by the user. Say so:
        // the transcript that follows covers only the audio that fit.
        warnings.push(format!(
            "Dictation reached the maximum length of {} minutes and was stopped. Only the audio captured up to that point was transcribed.",
            crate::audio::AudioCapture::dictation_max_session_seconds() / 60
        ));
    }
    let dictation_duration_seconds = match compute_wav_duration_seconds_from_bytes(&audio_bytes) {
        Ok(duration_seconds) => duration_seconds,
        Err(error) => {
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                Some(error.clone()),
                format!("Failed to read captured dictation duration: {}", error),
            )
            .await);
        }
    };

    // Dictionary entries always apply: `dictation_auto_learn_corrections`
    // only gates whether new entries are learned from user corrections
    // (see the auto-learn handlers), not whether existing entries — manual,
    // CSV-imported, or previously learned — are used. Loaded before
    // transcription (not after, as they once were) because the recognizer
    // gets them as a vocabulary hint as well as the text pass afterwards.
    let dictionary_entries = {
        let db = state.db.lock().await;
        match db.list_dictation_dictionary_entries() {
            Ok(entries) => entries,
            Err(error) => {
                drop(db);
                return Err(fail_dictation_stop(
                    state,
                    handle,
                    &failure_context,
                    None,
                    format!("Failed to read the dictation dictionary: {}", error),
                )
                .await);
            }
        }
    };
    let snippets = if settings_snapshot.transcription.dictation_snippets_enabled {
        let db = state.db.lock().await;
        match db.list_dictation_snippets() {
            Ok(snippets) => snippets,
            Err(error) => {
                drop(db);
                return Err(fail_dictation_stop(
                    state,
                    handle,
                    &failure_context,
                    None,
                    format!("Failed to read dictation snippets: {}", error),
                )
                .await);
            }
        }
    } else {
        Vec::new()
    };

    let formatting_hint = resolve_dictation_formatting_hint(
        app_target.as_deref(),
        dictation_options.activation_matcher.as_deref(),
        dictation_options.context_app_name.as_deref(),
    );
    // Resolve the destination-app category once — settings overrides,
    // bundle id, AND the browser-domain formatting hint — so the recognizer
    // vocabulary hint, dictionary/snippet category scoping and local smart
    // formatting all agree on the same category (matching what the LLM
    // prompt path resolves).
    let destination_category = settings::resolve_dictation_app_category_with_overrides_and_hint(
        &settings_snapshot.transcription,
        app_target.as_deref(),
        app_bundle_id.as_deref(),
        formatting_hint.as_deref(),
    );

    // Recognizer vocabulary bias, built from the same dictionary and snippet
    // entries the post-transcription pass applies and scoped the same way
    // (app, destination category, enabled). Whisper gets it as the initial
    // prompt; OpenAI/Groq as `prompt`; ElevenLabs as `keyterms`; every other
    // provider ignores it. `None` when nothing applies, so no provider ever
    // sees a blank hint.
    // Translate-to-English (B7a): decided once, before the recognizer runs,
    // because multilingual whisper.cpp does the translation inside the
    // decode while every other route needs a second pass afterwards.
    let translation_route = resolve_dictation_translation_route(
        provider_type,
        actual_model_id.as_deref().unwrap_or_default(),
        dictation_translate_to_english_enabled(&settings_snapshot),
    );
    let transcription_options = asr::TranscriptionOptions {
        vocabulary_hint: crate::dictation_parity::build_vocabulary_hint(
            &crate::dictation_pipeline::vocabulary_candidates_from_entries(
                &dictionary_entries,
                &snippets,
            ),
            app_target.as_deref(),
            destination_category,
        ),
        translate_to_english: translation_route == DictationTranslationRoute::WhisperNative,
        // Dictation is served correctly by either Apple engine; only the
        // meeting route depends on SpeechAnalyzer's timed segments.
        apple_speech_required_engine: None,
        request_speaker_labels: false,
        language: settings_snapshot.transcription.language.clone(),
    };
    let vocabulary_hint_terms_built = transcription_options
        .vocabulary_hint
        .as_ref()
        .map(|hint| hint.terms().len())
        .unwrap_or(0);

    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "transcribing".to_string();
        overlay.message = Some("Transcribing…".to_string());
    }
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "transcribing",
            "sessionId": session_id,
            "message": "Transcribing…",
            "requestedProvider": asr_provider_to_settings_value(requested_provider_type),
            "actualProvider": asr_provider_to_settings_value(provider_type),
            "requestedModelId": requested_model_id.clone(),
            "actualModelId": actual_model_id.clone(),
            "resolvedModePreset": dictation_options.resolved_mode_preset,
            "resolvedCustomModeId": dictation_options.resolved_custom_mode_id,
            "resolvedModeLabel": dictation_options.resolved_mode_label,
            "contextSource": dictation_options.context_source,
            "insertionMode": requested_insertion_mode,
            "appTarget": app_target.clone(),
            "activationMatcher": dictation_options.activation_matcher,
            "requestedRoute": dictation_options.route_preference,
            "resolvedRoute": dictation_options.resolved_route,
            "providerModelLabel": dictation_options.provider_model_label,
            "dictationRoutePreference": dictation_options.route_preference,
            "dictationResolvedHosting": dictation_options.resolved_hosting,
        }),
    );

    let transcription_result = match state
        .asr_manager
        .transcribe_bytes_for_dictation_with_options(
            provider_type,
            &audio_bytes,
            actual_model_id.as_deref(),
            &transcription_options,
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            let route_label = actual_model_id
                .as_deref()
                .map(|model| format!("{} / {}", provider_type.display_name(), model))
                .unwrap_or_else(|| provider_type.display_name().to_string());
            let user_message = format!(
                "Dictation transcription failed on {}: {}",
                route_label, error
            );
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                Some(error.to_string()),
                user_message,
            )
            .await);
        }
    };

    // Built is what the dictionary offered; applied is what the route that
    // actually ran attached (a whisper decode withholds it on near-silent
    // audio, cloud routes without a prompt field ignore it entirely). Only
    // the second says the dictionary reached the recognizer.
    let vocabulary_hint_terms_applied = transcription_result.vocabulary_hint_terms_applied;
    if vocabulary_hint_terms_built > 0 {
        tracing::info!(
            "Dictation vocabulary hint: {} term(s) built, {} applied by {}",
            vocabulary_hint_terms_built,
            vocabulary_hint_terms_applied,
            transcription_result.actual_provider.display_name()
        );
    }

    let final_transcript_at_epoch_ms = chrono::Utc::now().timestamp_millis();
    let final_transcript_latency_ms = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.final_transcript_at_epoch_ms = Some(final_transcript_at_epoch_ms);
        tracker
            .stop_requested_at
            .map(|stopped_at| stopped_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
    };

    let raw_transcribed_text =
        sanitize_dictation_output(&transcription_result.text, &transcription_result.text)
            .trim()
            .to_string();
    let now = chrono::Utc::now();
    let recent_delivery = state.recent_dictation_delivery.lock().await.clone();
    let recent_inserted_text = recent_delivery
        .as_ref()
        .filter(|delivery| {
            recent_delivery_matches_target_and_is_fresh(
                delivery,
                app_target.as_deref(),
                app_bundle_id.as_deref(),
                now,
            )
        })
        .map(|delivery| delivery.text.as_str());

    let effective_mode = resolved_dictation_mode_preset(&settings_snapshot).to_string();

    let mut final_text = raw_transcribed_text.clone();
    let mut command_applied: Option<String> = None;
    let mut prompt_source: Option<String> = None;
    let mut prompt_preview: Option<String> = None;
    let mut dictionary_applied_count = 0usize;
    let mut snippet_applied_count = 0usize;
    let mut formatting_applied = false;
    let mut recent_insert_reused = false;
    let mut pipeline_stage_keys: Vec<String> = Vec::new();
    let mut undo_previous_insert = false;
    // Timing-record fields for the format/cleanup stage. Stays
    // `NotApplicable` unless the pipeline below actually reaches formatting
    // (an empty transcript or a consumed command skips it entirely).
    let mut format_outcome = crate::dictation_timing::DictationFormatOutcome::NotApplicable;

    if settings_snapshot
        .transcription
        .dictation_command_mode_enabled
    {
        if let Some((command_key, action)) = parse_dictation_command(
            raw_transcribed_text.as_str(),
            &settings_snapshot.transcription.dictation_command_prefix,
        ) {
            // Command mode ships on while the text-context source defaults to
            // "none", so every selection-scoped command would otherwise have
            // nothing to work on. Capture the selection here — only once a
            // command actually parsed — instead of defaulting the context
            // source to "selected_text", which would fire a synthetic copy
            // into the frontmost app (and clobber the clipboard) on every
            // ordinary dictation.
            let mut command_context_text = dictation_options.captured_context_text.clone();
            let mut command_context_source =
                normalize_dictation_context_source(&dictation_options.context_source).to_string();
            let needs_context =
                crate::dictation_parity::dictation_command_action_needs_context(&action);
            if needs_context
                && command_context_source == "none"
                && command_context_text
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or_default()
                    .is_empty()
            {
                command_context_source = "selected_text".to_string();
                match capture_dictation_context_text("selected_text", app_target.as_deref()) {
                    Ok(captured) => command_context_text = captured,
                    Err(error) => tracing::info!(
                        "Selection capture for dictation command '{}' failed: {}",
                        command_key,
                        error
                    ),
                }
            }

            match execute_dictation_command_action(
                state,
                &command_key,
                action,
                command_context_text.as_deref(),
                &command_context_source,
            )
            .await
            {
                Ok(execution) => {
                    final_text = execution.output_text.trim().to_string();
                    command_applied = Some(execution.command_applied);
                    prompt_source = execution.prompt_source;
                    prompt_preview = execution.prompt_preview;
                    undo_previous_insert = execution.undo_previous_insert;
                    pipeline_stage_keys.push("command".to_string());
                }
                Err(DictationCommandError::MissingContext(warning)) => {
                    // Non-fatal: leave `command_applied` unset so the ordinary
                    // pipeline below runs on the raw transcript. The user gets
                    // their words plus an explanation, instead of a failed stop.
                    tracing::warn!(
                        "Dictation command '{}' had no text to work on: {}",
                        command_key,
                        warning
                    );
                    warnings.push(warning);
                }
                Err(DictationCommandError::Failed(error)) => {
                    return Err(
                        fail_dictation_stop(state, handle, &failure_context, None, error).await,
                    );
                }
            }
        }
    }

    if command_applied.is_none() {
        // `destination_category` was resolved once, before transcription, so
        // the recognizer hint and this pass scope entries identically.
        let pipeline_result = crate::dictation_pipeline::apply_dictation_pipeline(
            crate::dictation_pipeline::DictationPipelineInput {
                text: raw_transcribed_text.as_str(),
                dictionary_entries: &dictionary_entries,
                snippets: &snippets,
                app_target: app_target.as_deref(),
                mode_preset: effective_mode.as_str(),
                smart_formatting_enabled: true,
                numbers_as_digits: resolve_dictation_numbers_as_digits(&settings_snapshot),
                recent_inserted_text,
                destination_category,
            },
        );
        final_text = pipeline_result.text.trim().to_string();
        command_applied = pipeline_result.command_applied.clone();
        dictionary_applied_count = pipeline_result.dictionary_applied_count;
        snippet_applied_count = pipeline_result.snippet_applied_count;
        formatting_applied = pipeline_result.formatting_applied;
        recent_insert_reused = pipeline_result.recent_insert_reused;
        pipeline_stage_keys = pipeline_result.pipeline_stage_keys.clone();
        undo_previous_insert = pipeline_result.undo_previous_insert;
    }

    // Baseline for the format/cleanup stage: reached, and the local pipeline
    // pass above already ran (it runs unconditionally whenever there is no
    // command to service). The match below only ever narrows this further
    // -- to `Skipped` when a mode has no local equivalent and LLM formatting
    // is off, or to `TimedOut`/`Failed` when an LLM pass was attempted and
    // didn't return cleanly.
    if !final_text.is_empty() && command_applied.is_none() {
        format_outcome = crate::dictation_timing::DictationFormatOutcome::Applied;
    }

    // One budget for the whole pre-insert stretch, not one per pass. A single
    // dictation can run translate-to-English and then a formatting pass back
    // to back; taking a fresh `dictation_format_timeout` for each made the
    // real worst-case insertion delay twice the constant (12 s local). The
    // clock starts inside the first pass -- provider resolution and prompt
    // building stay outside it deliberately -- and every later pass gets what
    // is left. See `DictationPreInsertBudget`.
    let mut pre_insert_budget = crate::dictation_timing::DictationPreInsertBudget::new();

    // Translate-to-English through the AI lane (B7a). Runs before the mode
    // transform / Smart Format pass so that pass formats English, out of the
    // shared pre-insert budget above. A failed or timed-out translation keeps
    // the source-language words -- the user's speech must never be lost to a
    // slow model -- and says so.
    let mut translation_applied =
        translation_route == DictationTranslationRoute::WhisperNative && !final_text.is_empty();
    if translation_route == DictationTranslationRoute::AiLane
        && !final_text.is_empty()
        && command_applied.is_none()
    {
        let attempt = match selected_analysis_provider_and_settings(
            state,
            settings::AiLane::Dictation,
        )
        .await
        .and_then(|(provider, remote_processing_enabled, _, _)| {
            enforce_remote_provider_policy(provider, remote_processing_enabled).map(|()| provider)
        }) {
            Ok(provider) => {
                let format_timeout = pre_insert_budget.remaining(
                    dictation_format_timeout(provider),
                    std::time::Instant::now(),
                );
                let translated = tokio::time::timeout(
                    format_timeout,
                    run_custom_dictation_transform_with_selected_provider(
                        state,
                        final_text.as_str(),
                        DICTATION_TRANSLATE_TO_ENGLISH_PROMPT,
                    ),
                )
                .await;
                match translated {
                    Ok(Ok((output, _, _))) => {
                        crate::dictation_timing::DictationFormatAttempt::Applied(output)
                    }
                    Ok(Err(error)) => {
                        tracing::warn!(
                            "Translate-to-English failed, inserting the source-language words: {}",
                            error
                        );
                        crate::dictation_timing::DictationFormatAttempt::Failed
                    }
                    Err(_) => {
                        tracing::warn!(
                            "Translate-to-English timed out after {}ms, inserting the source-language words",
                            format_timeout.as_millis()
                        );
                        crate::dictation_timing::DictationFormatAttempt::TimedOut
                    }
                }
            }
            Err(error) => {
                tracing::warn!(
                    "Translate-to-English could not resolve an AI provider, inserting the source-language words: {}",
                    error
                );
                crate::dictation_timing::DictationFormatAttempt::Failed
            }
        };
        let fallback =
            crate::dictation_timing::resolve_dictation_format_attempt(attempt, final_text.as_str());
        if fallback.format_outcome == crate::dictation_timing::DictationFormatOutcome::Applied {
            final_text = sanitize_dictation_output(fallback.final_text.trim(), final_text.as_str())
                .trim()
                .to_string();
            translation_applied = true;
            pipeline_stage_keys.push("translate_to_english".to_string());
        } else {
            final_text = fallback.final_text;
            warnings.push(DICTATION_TRANSLATE_FAILED_WARNING.to_string());
            pipeline_stage_keys.push("translate_to_english_fallback".to_string());
        }
    }

    if !final_text.is_empty() && command_applied.is_none() {
        match effective_mode.as_str() {
            // Same gate and the same insertion-delay cap as the Smart Format
            // branch below: this arm used to call the model on every single
            // dictation with no opt-in and no timeout, then quietly replace the
            // result with a crude local rewrite whenever the call failed.
            "messages" | "email" | "meeting_follow_up" => {
                if let Some((prompt, resolved_prompt_source)) =
                    resolve_dictation_mode_transform_prompt(&settings_snapshot, &effective_mode)
                        .filter(|_| {
                            dictation_llm_formatting_enabled(&settings_snapshot, &dictation_options)
                        })
                {
                    // Resolve the provider (and enforce remote-processing
                    // policy) before the clock starts: neither is the model
                    // call the budget is meant to time, and a policy-blocked
                    // remote provider should fail fast rather than occupy
                    // the timer only to be rejected inside it.
                    let attempt = match selected_analysis_provider_and_settings(
                        state,
                        settings::AiLane::Dictation,
                    )
                    .await
                    .and_then(|(provider, remote_processing_enabled, _, _)| {
                        enforce_remote_provider_policy(provider, remote_processing_enabled)
                            .map(|()| provider)
                    }) {
                        Ok(provider) => {
                            let format_timeout = pre_insert_budget.remaining(
                                dictation_format_timeout(provider),
                                std::time::Instant::now(),
                            );
                            let transform = tokio::time::timeout(
                                format_timeout,
                                run_custom_dictation_transform_with_selected_provider(
                                    state,
                                    final_text.as_str(),
                                    prompt.as_str(),
                                ),
                            )
                            .await;
                            match transform {
                                Ok(Ok((output, _, _))) => {
                                    crate::dictation_timing::DictationFormatAttempt::Applied(output)
                                }
                                Ok(Err(error)) => {
                                    // Keep the local pipeline output
                                    // verbatim: it is the user's words,
                                    // correctly formatted.
                                    tracing::warn!(
                                        "Dictation mode transform for '{}' failed, keeping local pipeline output: {}",
                                        effective_mode,
                                        error
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::Failed
                                }
                                Err(_) => {
                                    tracing::warn!(
                                        "Dictation mode transform for '{}' timed out after {}ms, keeping local pipeline output",
                                        effective_mode,
                                        format_timeout.as_millis()
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::TimedOut
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                "Dictation mode transform for '{}' could not resolve a provider, keeping local pipeline output: {}",
                                effective_mode,
                                error
                            );
                            crate::dictation_timing::DictationFormatAttempt::Failed
                        }
                    };
                    let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
                        attempt,
                        final_text.as_str(),
                    );
                    format_outcome = fallback.format_outcome;
                    match format_outcome {
                        crate::dictation_timing::DictationFormatOutcome::Applied => {
                            final_text = sanitize_dictation_output(
                                fallback.final_text.trim(),
                                final_text.as_str(),
                            )
                            .trim()
                            .to_string();
                            prompt_source = Some(resolved_prompt_source);
                            prompt_preview = truncate_for_audit_preview(Some(prompt.as_str()), 180);
                            pipeline_stage_keys.push("mode_transform".to_string());
                        }
                        _ => {
                            final_text = fallback.final_text;
                            if fallback.warn_failed {
                                warnings.push(DICTATION_FORMAT_FAILED_WARNING.to_string());
                            }
                            if fallback.warn_timed_out {
                                warnings.push(DICTATION_FORMAT_TIMEOUT_WARNING.to_string());
                            }
                            pipeline_stage_keys.push("mode_transform_fallback".to_string());
                        }
                    }
                } else {
                    // No local equivalent exists for "rewrite this as an
                    // email" -- the stage was reached but had nothing to run,
                    // because Smart Format / AI formatting is off.
                    format_outcome = crate::dictation_timing::DictationFormatOutcome::Skipped;
                }
            }
            "notes" => {
                let bulletized = bulletize_text(final_text.as_str());
                if bulletized != final_text {
                    final_text = bulletized;
                    pipeline_stage_keys.push("mode_transform".to_string());
                }
                format_outcome = crate::dictation_timing::DictationFormatOutcome::Applied;
            }
            _ => {
                if dictation_llm_formatting_enabled(&settings_snapshot, &dictation_options) {
                    // Preparation (provider/model resolution, frontmost-app
                    // lookup, prompt building) runs before the clock starts;
                    // only `execute_dictation_formatting_request` -- the
                    // actual model call -- is timed.
                    let attempt = match prepare_dictation_formatting_request(
                        state,
                        &dictation_options,
                    )
                    .await
                    {
                        Ok(prepared) => {
                            let format_timeout = pre_insert_budget.remaining(
                                dictation_format_timeout(prepared.provider),
                                std::time::Instant::now(),
                            );
                            let formatting = tokio::time::timeout(
                                format_timeout,
                                execute_dictation_formatting_request(
                                    state,
                                    &prepared,
                                    final_text.as_str(),
                                ),
                            )
                            .await;
                            match formatting {
                                Ok(Ok(output)) => {
                                    crate::dictation_timing::DictationFormatAttempt::Applied(output)
                                }
                                Ok(Err(error)) => {
                                    tracing::warn!(
                                        "LLM dictation formatting failed, keeping local pipeline output: {}",
                                        error
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::Failed
                                }
                                Err(_) => {
                                    tracing::warn!(
                                        "LLM dictation formatting timed out after {}ms, keeping local pipeline output",
                                        format_timeout.as_millis()
                                    );
                                    crate::dictation_timing::DictationFormatAttempt::TimedOut
                                }
                            }
                        }
                        Err(error) => {
                            tracing::warn!(
                                "LLM dictation formatting could not be prepared, keeping local pipeline output: {}",
                                error
                            );
                            crate::dictation_timing::DictationFormatAttempt::Failed
                        }
                    };
                    let fallback = crate::dictation_timing::resolve_dictation_format_attempt(
                        attempt,
                        final_text.as_str(),
                    );
                    format_outcome = fallback.format_outcome;
                    match format_outcome {
                        crate::dictation_timing::DictationFormatOutcome::Applied => {
                            final_text = sanitize_dictation_output(
                                fallback.final_text.trim(),
                                final_text.as_str(),
                            )
                            .trim()
                            .to_string();
                            let (resolved_prompt_source, resolved_prompt_preview) =
                                resolve_dictation_format_prompt_metadata(&settings_snapshot);
                            prompt_source = resolved_prompt_source;
                            prompt_preview =
                                truncate_for_audit_preview(resolved_prompt_preview.as_deref(), 180);
                            if !pipeline_stage_keys
                                .iter()
                                .any(|stage| stage == "smart_formatting")
                            {
                                pipeline_stage_keys.push("smart_formatting".to_string());
                            }
                            formatting_applied = true;
                        }
                        _ => {
                            final_text = fallback.final_text;
                            if fallback.warn_failed {
                                warnings.push(DICTATION_FORMAT_FAILED_WARNING.to_string());
                            }
                            if fallback.warn_timed_out {
                                warnings.push(DICTATION_FORMAT_TIMEOUT_WARNING.to_string());
                            }
                        }
                    }
                }
                // else: LLM formatting is off. The local pipeline's smart-
                // format pass already ran above; baseline `Applied` stands.
            }
        }
    }
    // `None` when the stage was never reached at all (empty transcript, or a
    // command consumed the utterance): `NotApplicable` must mean exactly
    // that, not "reached instantly," so this is guarded on the same
    // condition that flips `format_outcome` off its `NotApplicable` default.
    let format_complete_ms = (format_outcome
        != crate::dictation_timing::DictationFormatOutcome::NotApplicable)
        .then(|| {
            stop_signal_instant
                .elapsed()
                .as_millis()
                .min(u128::from(u64::MAX)) as u64
        });

    final_text = sanitize_dictation_output(final_text.as_str(), raw_transcribed_text.as_str())
        .trim()
        .to_string();

    // Escape (force_stop_dictation) clears the active session while this stop
    // is still transcribing or formatting. Honor it: a cancel that let the
    // text land anyway would be a lie, and force_stop has already reset the
    // runtime and emitted its terminal phase, so there is nothing left to
    // clean up here.
    if active_dictation_session_id(state).await != Some(session_id) {
        tracing::info!(
            "Dictation session {} was cancelled before insertion; discarding the result",
            session_id
        );
        return Ok(String::new());
    }

    let startup_latency_ms = {
        let tracker = state.dictation_session_tracker.lock().await;
        tracker.startup_latency_ms
    };
    let transcription_latency_ms = transcription_result.processing_time_ms;
    let recording_id = uuid::Uuid::new_v4().to_string();
    let stored_text = if final_text.trim().is_empty() {
        raw_transcribed_text.clone()
    } else {
        final_text.clone()
    };
    let transcript = models::Transcript {
        id: uuid::Uuid::new_v4().to_string(),
        recording_id: recording_id.clone(),
        segments: if stored_text == raw_transcribed_text {
            transcription_result
                .segments
                .iter()
                .cloned()
                .map(|segment| models::TranscriptSegment {
                    id: uuid::Uuid::new_v4().to_string(),
                    start_time: segment.start_time,
                    end_time: segment.end_time,
                    text: segment.text,
                    speaker_id: None,
                    confidence: segment.confidence,
                })
                .collect()
        } else if stored_text.is_empty() {
            Vec::new()
        } else {
            vec![models::TranscriptSegment {
                id: uuid::Uuid::new_v4().to_string(),
                start_time: 0.0,
                end_time: 0.0,
                text: stored_text.clone(),
                speaker_id: None,
                confidence: transcription_result.confidence,
            }]
        },
        full_text: stored_text.clone(),
        language: transcription_result.language.clone(),
        confidence: transcription_result.confidence,
        model: transcription_result.model_name.clone(),
        model_id: Some(transcription_result.model_id.clone()),
        requested_provider: Some(
            asr_provider_to_settings_value(transcription_result.requested_provider).to_string(),
        ),
        actual_provider: Some(
            asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
        ),
        created_at: now,
    };
    // Opt-in: keep the captured WAV so this entry can be processed again.
    // Written before the row so a failed write never leaves a row that claims
    // audio it does not have; a failed row write removes the file again below.
    let kept_audio_path = if settings_snapshot.transcription.dictation_keep_audio {
        match write_kept_dictation_audio(&recording_id, &audio_bytes) {
            Ok(path) => Some(path),
            Err(error) => {
                tracing::warn!("Dictation audio was not kept: {}", error);
                warnings.push(format!(
                    "The dictation audio could not be kept for Process again: {error}"
                ));
                None
            }
        }
    } else {
        None
    };
    let kept_audio_metadata = kept_audio_path
        .as_deref()
        .map(recording_audio::validate_plaintext_wav)
        .and_then(|validation| match validation {
            recording_audio::RecordingAudioValidation::Ready(metadata) => Some(metadata),
            _ => None,
        });
    let history_text = crate::store::DictationHistoryTextRecord {
        recording_id: recording_id.clone(),
        final_text: stored_text.clone(),
        raw_text: raw_transcribed_text.clone(),
        reprocessed_from_id: None,
        mode_preset: Some(effective_mode.clone()),
        created_at: now,
    };
    let recording = models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Dictation - {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: dictation_options
            .project_id
            .clone()
            .unwrap_or_else(|| "inbox".to_string()),
        duration: dictation_duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "dictation".to_string(),
        audio_path: kept_audio_metadata
            .as_ref()
            .and(kept_audio_path.as_ref())
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        status: "completed".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: None,
        meeting_template_id: None,
        meeting_capture_mode: None,
        imported_source_name: None,
        notes_updated_at: None,
        consent_prompt_shown: false,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        attendees: Vec::new(),
        pause_spans: Vec::new(),
        video_service: None,
    };

    // Cursor delivery crosses native process and accessibility boundaries.
    // Commit the only recoverable copy first, as one transaction, so a helper
    // failure or app termination during insertion cannot erase the words.
    {
        let mut db = state.db.lock().await;
        if let Err(error) = db.create_dictation_history_entry(
            &recording,
            &transcript,
            &history_text,
            kept_audio_metadata.as_ref(),
        ) {
            drop(db);
            if let Some(path) = kept_audio_path.as_deref() {
                let _ = std::fs::remove_file(path);
            }
            record_recent_dictation_result(
                state,
                &final_text,
                app_target.as_deref(),
                dictation_options.context_app_bundle_id.as_deref(),
            );
            if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
                overlay.preview = Some(final_text.clone());
            }
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                None,
                format!(
                    "Plainsong could not save this dictation, so no text was inserted. \
                     Your words remain available in the dictation window: {}",
                    error
                ),
            )
            .await);
        }
    }

    // Kept dictation audio is an owned asset in the recordings store exactly
    // like a meeting's track, and it went in as `protection 'plaintext'`. With
    // the vault on it has to be encrypted here, or the words the reader chose
    // to keep sit in the clear under a vault the UI says covers them.
    //
    // A failure is a warning, not a refusal: the transcript is already
    // committed and the text still has to be delivered. The asset stays
    // plaintext and `get_security_status` keeps reporting it as such, which is
    // the truth, and the reader is told rather than left to find out.
    if kept_audio_metadata.is_some() {
        if let Err(error) =
            encrypt_finalized_recording_audio(state, Some(handle), &recording_id).await
        {
            tracing::warn!("Kept dictation audio was not encrypted: {}", error);
            warnings.push(format!(
                "The kept dictation audio is not in the vault yet: {error}"
            ));
        }
    }

    let mut insert_latency_ms: Option<u64> = None;
    let mut post_insert_focus_anchor: Option<
        dictation_correction_capture::FocusedFieldFingerprint,
    > = None;
    let mut pasted = false;
    let mut copied = false;
    let mut paste_error: Option<String> = None;
    let mut actual_insertion_mode = requested_insertion_mode.clone();
    let mut outcome = "ready".to_string();
    let mut undo_performed = false;
    // Timing-record fields for the insertion stage. Stay `None` unless text
    // insertion is actually dispatched below (preview-only delivery and an
    // undo-only command never reach it).
    let mut insertion_dispatched_ms: Option<u64> = None;
    let mut insertion_confirmed_ms: Option<u64> = None;
    let mut insertion_confirmed_flag = false;

    if preview_only {
        actual_insertion_mode = "preview".to_string();
        outcome = if final_text.is_empty() {
            "empty".to_string()
        } else {
            "previewed".to_string()
        };
    } else {
        if undo_previous_insert {
            if recent_inserted_text.is_some() {
                match send_native_undo_key() {
                    Ok(()) => {
                        undo_performed = true;
                        outcome = "undone".to_string();
                    }
                    Err(error) => {
                        paste_error = Some(error);
                    }
                }
            } else if final_text.is_empty() {
                paste_error = Some("No recent dictation insert was available to undo.".to_string());
                actual_insertion_mode = "command_only".to_string();
                outcome = "error".to_string();
            }
        }

        if !final_text.is_empty() {
            let insert_started_at = std::time::Instant::now();
            insertion_dispatched_ms = Some(
                stop_signal_instant
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
            let paste_outcome =
                match DictationInsertionMode::from_settings_value(&requested_insertion_mode) {
                    DictationInsertionMode::ClipboardOnly => {
                        // Clipboard-only delivery still hands the words to
                        // whatever is in front: a password box's owner can
                        // paste them straight back in. Same refusal as
                        // insertion, decided before the clipboard is touched.
                        let secure_field =
                            tokio::task::spawn_blocking(probe_clipboard_delivery_secure_field)
                                .await
                                .unwrap_or_else(|join_error| {
                                    tracing::warn!(
                                "Secure-field probe before clipboard delivery did not complete: {}",
                                join_error
                            );
                                    None
                                });
                        if let Some(signal) = secure_field {
                            secure_field_refusal_outcome(signal)
                        } else {
                            match copy_to_clipboard(final_text.as_str()) {
                                Ok(()) => PasteOutcome {
                                    pasted: false,
                                    copied: true,
                                    direct_accessibility: false,
                                    confirmed: false,
                                    successful_strategy: None,
                                    secure_field: None,
                                    error: None,
                                },
                                Err(error) => PasteOutcome {
                                    pasted: false,
                                    copied: false,
                                    direct_accessibility: false,
                                    confirmed: false,
                                    successful_strategy: None,
                                    secure_field: None,
                                    error: Some(error),
                                },
                            }
                        }
                    }
                    DictationInsertionMode::Auto => {
                        // Insertion shells out to `open`, waits for the target
                        // app to come forward, then polls for the paste to land
                        // -- close to a second of blocking work on the hottest
                        // dictation path. Running it inline stalled a tokio
                        // worker for that whole window. Hoist the few reads it
                        // needs, then hand the blocking body to the blocking
                        // pool, matching how `get_frontmost_app_name` is already
                        // dispatched.
                        let keep_text_in_clipboard = tracker_copy_to_clipboard(state).await;
                        let accessibility_trust_observed =
                            Arc::clone(&state.accessibility_trust_observed);
                        let insert_text = final_text.clone();
                        let insert_app_target = app_target.clone();
                        let insert_app_bundle_id = app_bundle_id.clone();
                        match tokio::task::spawn_blocking(move || {
                            paste_text_systemwide(
                                &accessibility_trust_observed,
                                insert_text.as_str(),
                                keep_text_in_clipboard,
                                insert_app_target.as_deref(),
                                insert_app_bundle_id.as_deref(),
                            )
                        })
                        .await
                        {
                            Ok(outcome) => outcome,
                            Err(join_error) => {
                                // A panic inside insertion must not be reported
                                // as a successful insert; the transcript is
                                // already durably committed above.
                                tracing::error!(
                                    "Dictation insertion task failed to complete: {}",
                                    join_error
                                );
                                PasteOutcome {
                                    pasted: false,
                                    copied: false,
                                    direct_accessibility: false,
                                    confirmed: false,
                                    successful_strategy: None,
                                    secure_field: None,
                                    error: Some(
                                        "Text insertion did not complete. The transcript was saved."
                                            .to_string(),
                                    ),
                                }
                            }
                        }
                    }
                };
            insert_latency_ms = Some(
                insert_started_at
                    .elapsed()
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64,
            );
            insertion_confirmed_flag = paste_outcome.confirmed;
            // Only a positively-confirmed insertion gets a confirmed
            // timestamp -- a bare Cmd+V with no read-back (`paste_dispatched`)
            // or a clipboard-only copy never confirms delivery, so recording
            // a timestamp here under either name would claim knowledge this
            // path doesn't have. `assemble_dictation_timing_record`'s
            // `total_ms` already falls back to `insertion_dispatched_ms` for
            // exactly this case.
            if insertion_confirmed_flag {
                insertion_confirmed_ms = Some(
                    stop_signal_instant
                        .elapsed()
                        .as_millis()
                        .min(u128::from(u64::MAX)) as u64,
                );
            }
            pasted = paste_outcome.pasted;
            copied = paste_outcome.copied;
            let secure_field_refused = paste_outcome.secure_field.is_some();
            if paste_error.is_none() {
                paste_error = paste_outcome.error;
            }
            // Anchor the insertion to the field it landed in, while the field
            // is still the one on screen. Gated on the setting, so with the
            // feature off Plainsong never reads a destination field at all —
            // not even this once.
            if pasted
                && settings_snapshot
                    .transcription
                    .dictation_learn_from_external_corrections
                && !is_self_activation_target(app_target.as_deref(), app_bundle_id.as_deref())
            {
                let anchor_text = final_text.clone();
                post_insert_focus_anchor = tokio::task::spawn_blocking(move || {
                    dictation_correction_capture::capture_insertion_anchor(
                        &MacosFocusedFieldReader,
                        anchor_text.as_str(),
                        // Re-asked against the app actually in front now. The
                        // check above used the target recorded when the
                        // session started, which is still "Slack" even when
                        // reactivation failed and the text landed here.
                        &is_self_activation_target,
                    )
                })
                .await
                .unwrap_or_else(|join_error| {
                    tracing::warn!(
                        "Post-insert correction anchor did not complete: {}",
                        join_error
                    );
                    None
                });
            }
            outcome = resolve_dictation_delivery_outcome(DictationDeliveryFacts {
                pasted,
                copied,
                confirmed: paste_outcome.confirmed,
                undo_performed,
                secure_field_refused,
                has_paste_error: paste_error.is_some(),
                previous: outcome.as_str(),
            });
        } else if undo_performed {
            actual_insertion_mode = "command_only".to_string();
        } else if paste_error.is_none() {
            outcome = "empty".to_string();
        }
    }

    let insertion_completed_at_epoch_ms = chrono::Utc::now().timestamp_millis();
    let (
        acknowledgement_latency_ms,
        capture_ready_latency_ms,
        first_stable_partial_latency_ms,
        acknowledged_at_epoch_ms,
        capture_ready_at_epoch_ms,
        first_stable_partial_at_epoch_ms,
        end_to_end_ms,
    ) = {
        let mut tracker = state.dictation_session_tracker.lock().await;
        tracker.insertion_completed_at_epoch_ms = Some(insertion_completed_at_epoch_ms);
        let started_at_epoch_ms = tracker.started_at_epoch_ms;
        let elapsed_from_start = |event_at: Option<i64>| {
            started_at_epoch_ms
                .zip(event_at)
                .map(|(start, event)| event.saturating_sub(start).max(0) as u64)
        };
        let end_to_end_ms = tracker
            .started_at
            .map(|started_at| started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(transcription_latency_ms + insert_latency_ms.unwrap_or(0));
        (
            elapsed_from_start(tracker.acknowledged_at_epoch_ms),
            elapsed_from_start(tracker.capture_ready_at_epoch_ms),
            elapsed_from_start(tracker.first_stable_partial_at_epoch_ms),
            tracker.acknowledged_at_epoch_ms,
            tracker.capture_ready_at_epoch_ms,
            tracker.first_stable_partial_at_epoch_ms,
            end_to_end_ms,
        )
    };
    // The Wave 3 timing record: stop-command-to-glyph (key-release-to-glyph
    // when Electron supplied the real gesture epoch -- see the function doc
    // above and dictation_timing.rs's module doc for the honest distinction),
    // not just ASR decode time. Additive on the completion event below and
    // logged once here -- one plain Instant captured above, no new locks, no
    // new syscalls, dropped on the floor if nothing reads it.
    let dictation_timing_record = crate::dictation_timing::assemble_dictation_timing_record(
        crate::dictation_timing::DictationTimingInputs {
            stop_command_received_at_epoch_ms,
            audio_finalized_ms,
            asr_complete_ms: final_transcript_latency_ms,
            format_complete_ms,
            format_outcome,
            insertion_dispatched_ms,
            insertion_confirmed_ms,
            insertion_confirmed: insertion_confirmed_flag,
        },
    );
    tracing::info!(
        "dictation {} timing: {}",
        session_id,
        crate::dictation_timing::format_dictation_timing_summary(&dictation_timing_record)
    );
    let fallback_message = build_provider_fallback_message(
        transcription_result.requested_provider,
        transcription_result.actual_provider,
        transcription_result.fallback_reason.as_deref(),
        transcription_result.optimization_applied,
    );

    {
        let mut db = state.db.lock().await;
        let _ = db.save_transcript_artifact(&TranscriptArtifactRecord {
            id: uuid::Uuid::new_v4().to_string(),
            recording_id: recording_id.clone(),
            transcript_id: Some(transcript.id.clone()),
            segment_count: transcript.segments.len() as i64,
            model_id: Some(transcription_result.model_id.clone()),
            requested_provider: Some(
                asr_provider_to_settings_value(transcription_result.requested_provider).to_string(),
            ),
            actual_provider: Some(
                asr_provider_to_settings_value(transcription_result.actual_provider).to_string(),
            ),
            quality_score: Some(transcription_result.confidence),
            startup_latency_ms: startup_latency_ms.map(|value| value as i64),
            transcription_latency_ms: Some(transcription_latency_ms as i64),
            insert_latency_ms: insert_latency_ms.map(|value| value as i64),
            end_to_end_ms: Some(end_to_end_ms as i64),
            created_at: now,
        });
        let _ = db.save_insertion_action(&InsertionActionRecord {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: Some(session_id.to_string()),
            recording_id: Some(recording_id.clone()),
            requested_mode: requested_insertion_mode.clone(),
            actual_mode: actual_insertion_mode.clone(),
            pasted,
            copied,
            failed: paste_error.is_some() && !pasted && !copied,
            undo_token: None,
            command_applied: command_applied.clone(),
            snippet_applied_count: snippet_applied_count as i64,
            app_target: app_target.clone(),
            error: paste_error.clone(),
            created_at: now,
        });

        let custom_mode = active_dictation_custom_mode(&settings_snapshot);
        let audit_details = strip_captured_context_from_dictation_audit(serde_json::json!({
            "recording_id": &recording_id,
            "session_id": session_id.to_string(),
            "stop_reason": stop_reason,
            "dictation_mode_preset": dictation_options.resolved_mode_preset,
            "dictation_mode_label": dictation_options.resolved_mode_label,
            "dictation_base_mode_preset": effective_mode,
            "dictation_base_mode_label": resolved_dictation_base_mode_label(&settings_snapshot),
            "dictation_custom_mode_id": custom_mode.map(|mode| mode.id.clone()),
            "dictation_custom_mode_name": custom_mode.map(|mode| mode.name.clone()),
            "context_source": normalize_dictation_context_source(&dictation_options.context_source),
            "context_app_name": dictation_options.context_app_name,
            "app_target": app_target,
            "activation_matcher": dictation_options.activation_matcher,
            "command_applied": command_applied,
            "dictionary_applied_count": dictionary_applied_count,
            "snippet_applied_count": snippet_applied_count,
            "vocabulary_hint_terms_built": vocabulary_hint_terms_built,
            "vocabulary_hint_terms_applied": vocabulary_hint_terms_applied,
            "formatting_applied": formatting_applied,
            "recent_insert_reused": recent_insert_reused,
            "pipeline_stage_keys": pipeline_stage_keys,
            "prompt_source": prompt_source,
            "prompt_preview": prompt_preview,
            "requested_provider": asr_provider_to_settings_value(transcription_result.requested_provider),
            "actual_provider": asr_provider_to_settings_value(transcription_result.actual_provider),
            "model_id": transcription_result.model_id,
            "route_preference": dictation_options.route_preference,
            "resolved_hosting": dictation_options.resolved_hosting,
            "acknowledgement_latency_ms": acknowledgement_latency_ms,
            "capture_ready_latency_ms": capture_ready_latency_ms,
            "first_stable_partial_latency_ms": first_stable_partial_latency_ms,
            "final_transcript_latency_ms": final_transcript_latency_ms,
            "startup_latency_ms": startup_latency_ms,
            "transcription_latency_ms": transcription_latency_ms,
            "insert_latency_ms": insert_latency_ms,
            "end_to_end_ms": end_to_end_ms,
            "outcome": outcome,
            "warnings": warnings,
            "timing": dictation_timing_record,
        }));
        // Added after the literal above: `serde_json::json!` expands
        // recursively per key and that object already sits at the compiler's
        // recursion limit.
        let mut audit_details = audit_details;
        if let Some(map) = audit_details.as_object_mut() {
            map.insert(
                "dictation_mode_override".to_string(),
                serde_json::json!(dictation_options
                    .mode_override
                    .as_ref()
                    .map(|value| value.preset.clone())),
            );
            map.insert(
                "detected_language".to_string(),
                serde_json::json!(transcription_result.language),
            );
            map.insert(
                "translation_route".to_string(),
                serde_json::json!(translation_route.as_audit_value()),
            );
            map.insert(
                "translation_applied".to_string(),
                serde_json::json!(translation_route
                    .as_audit_value()
                    .map(|_| translation_applied)),
            );
        }
        let _ = db.log_audit_event("dictation_completed", Some(audit_details), "info");
    }

    // A cloud dictation route may have left a file behind on the provider's
    // side. There is no finished recording to hang a note on here, so this
    // lands in the audit log only.
    report_provider_cleanup_warnings(state, None::<(&crate::sidecar_handle::SidecarHandle, &str)>)
        .await;

    {
        let mut recent_delivery_slot = state.recent_dictation_delivery.lock().await;
        if pasted || copied {
            *recent_delivery_slot = Some(RecentDictationDelivery {
                text: final_text.clone(),
                app_target: app_target.clone(),
                app_bundle_id: app_bundle_id.clone(),
                delivered_at: now,
            });
        } else if undo_performed {
            *recent_delivery_slot = None;
        }
    }

    if let Some(anchor) = post_insert_focus_anchor {
        schedule_post_insert_correction_readback(
            state,
            handle,
            final_text.clone(),
            app_target.clone(),
            anchor,
            now,
        );
    }

    reset_dictation_session_runtime(
        &state.dictation_runtime_state,
        &state.dictation_session_tracker,
        &state.dictation_start_options,
    )
    .await;

    let done_message = dictation_done_message(&outcome, final_text.is_empty(), &warnings);

    // Emit done phase so the popup shows the result, then idle to dismiss it.
    if let Ok(mut overlay) = state.dictation_overlay_state.lock() {
        overlay.phase = "done".to_string();
        overlay.message = Some(done_message.clone());
        overlay.preview = Some(final_text.clone());
        overlay.stop_reason = Some(stop_reason.to_string());
        overlay.outcome = Some(outcome.clone());
    }
    let payload = build_dictation_text_ready_payload(
        session_id,
        stop_reason,
        &outcome,
        &transcription_result,
        pasted,
        copied,
        paste_error.as_deref(),
        fallback_message.as_deref(),
        acknowledgement_latency_ms,
        capture_ready_latency_ms,
        first_stable_partial_latency_ms,
        final_transcript_latency_ms,
        startup_latency_ms,
        transcription_latency_ms,
        insert_latency_ms,
        end_to_end_ms,
        acknowledged_at_epoch_ms,
        capture_ready_at_epoch_ms,
        first_stable_partial_at_epoch_ms,
        final_transcript_at_epoch_ms,
        insertion_completed_at_epoch_ms,
        actual_insertion_mode.as_str(),
        command_applied.as_deref(),
        dictionary_applied_count,
        snippet_applied_count,
        formatting_applied,
        recent_insert_reused,
        &pipeline_stage_keys,
        app_target.as_deref(),
        dictation_options.activation_matcher.as_deref(),
        Some(normalize_dictation_context_source(
            &dictation_options.context_source,
        )),
        dictation_options
            .captured_context_text
            .as_deref()
            .map(|value| value.chars().count()),
        dictation_options.route_preference.as_deref(),
        dictation_options.resolved_route.as_deref(),
        dictation_options.resolved_hosting.as_deref(),
        dictation_options.provider_model_label.as_deref(),
        &warnings,
        dictation_timing_record,
    );
    let mut payload_value = match serde_json::to_value(payload) {
        Ok(value) => value,
        Err(error) => {
            return Err(fail_dictation_stop(
                state,
                handle,
                &failure_context,
                None,
                format!("Failed to build the dictation result event: {}", error),
            )
            .await);
        }
    };
    if let Some(object) = payload_value.as_object_mut() {
        object.insert(
            "text".to_string(),
            serde_json::Value::String(final_text.clone()),
        );
    }
    record_recent_dictation_result(
        state,
        &final_text,
        app_target.as_deref(),
        dictation_options.context_app_bundle_id.as_deref(),
    );
    handle.emit_event("dictation-text-ready", payload_value);
    handle.emit_event(
        "dictation-state-changed",
        serde_json::json!({
            "phase": "done",
            "sessionId": session_id,
            "stopReason": stop_reason,
            "outcome": outcome,
            "preview": &final_text,
            "message": done_message,
            "resolvedModePreset": dictation_options.resolved_mode_preset,
            "resolvedCustomModeId": dictation_options.resolved_custom_mode_id,
            "resolvedModeLabel": dictation_options.resolved_mode_label,
            "contextSource": dictation_options.context_source,
            "insertionMode": actual_insertion_mode,
            "appTarget": app_target.clone(),
            "activationMatcher": dictation_options.activation_matcher,
            "dictationProvider": asr_provider_to_settings_value(provider_type),
            "dictationModelId": actual_model_id.clone(),
            "requestedProvider": asr_provider_to_settings_value(transcription_result.requested_provider),
            "actualProvider": asr_provider_to_settings_value(transcription_result.actual_provider),
            "requestedModelId": dictation_options.requested_model_id.clone(),
            "actualModelId": dictation_options.actual_model_id.clone(),
            "requestedRoute": dictation_options.route_preference,
            "resolvedRoute": dictation_options.resolved_route,
            "providerModelLabel": dictation_options.provider_model_label,
            "dictationRoutePreference": dictation_options.route_preference,
            "dictationResolvedHosting": dictation_options.resolved_hosting,
        }),
    );

    // Honor the dictation retention preset as soon as a session completes
    // (mirrors `enforce_meeting_retention_policy` after meeting
    // transcription), so "Immediately"/short retention windows work without
    // waiting for the daily maintenance pass.
    if let Err(error) =
        enforce_dictation_retention_policy(state, Some(handle), "dictation-completed").await
    {
        tracing::warn!(
            "Dictation retention cleanup after session completion failed: {}",
            error
        );
    }

    // Keep the result visible briefly, then reset to idle — but do it on a
    // detached task so this command returns immediately. Otherwise the stop
    // handler blocks for ~1.8s, which (a) delays the response and (b) prevented
    // starting the next dictation until the display window elapsed.
    //
    // A delivery failure lands here too, and it needs the longer error window:
    // the words exist only in dictation history, so 1.8s is not enough time to
    // notice that nothing arrived and act on it.
    schedule_dictation_overlay_idle_reset(
        state,
        handle,
        session_id,
        stop_reason,
        dictation_overlay_idle_reset_delay_ms(&outcome),
    );

    Ok(final_text)
}

/// How long the done HUD stays up before resetting to idle. A successful
/// delivery is self-evident and gets the short window; a failed one leaves the
/// text only in dictation history, so the user needs long enough to notice and
/// reach for it.
fn dictation_overlay_idle_reset_delay_ms(outcome: &str) -> u64 {
    // A secure-field refusal is a non-delivery too: the words exist only in
    // dictation history, so it gets the same longer window as an error.
    if outcome == "error" || outcome == dictation_secure_field::SECURE_FIELD_REASON_CODE {
        DICTATION_IDLE_RESET_ERROR_MS
    } else {
        DICTATION_IDLE_RESET_SUCCESS_MS
    }
}

/// Whether a scheduled idle reset still owns the overlay it was scheduled for.
/// `None` means no session has claimed the overlay, so the reset is safe.
fn dictation_idle_reset_applies(overlay_session_id: Option<u64>, scheduled_for: u64) -> bool {
    match overlay_session_id {
        Some(active) => active == scheduled_for,
        None => true,
    }
}

/// Take the always-on-top dictation HUD down after `delay_ms` and put the
/// overlay state back to idle. Detached so the caller returns immediately.
///
/// Every terminal phase must schedule one of these. A phase that emits `done`
/// or `error` and schedules nothing leaves a floating panel on screen with no
/// timer behind it, which is exactly how a failed dictation used to park the
/// HUD over the user's work until they found the close button.
fn schedule_dictation_overlay_idle_reset(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    session_id: u64,
    stop_reason: &str,
    delay_ms: u64,
) {
    let overlay_state = Arc::clone(&state.dictation_overlay_state);
    let idle_handle = handle.clone();
    let idle_stop_reason = stop_reason.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;

        if let Ok(mut overlay) = overlay_state.lock() {
            // A newer session may have claimed the overlay while this timer
            // ran; resetting then would hide a HUD that is legitimately live.
            if !dictation_idle_reset_applies(overlay.session_id, session_id) {
                return;
            }
            *overlay = DictationOverlayState::default();
        }
        idle_handle.emit_event(
            "dictation-state-changed",
            serde_json::json!({
                "phase": "idle",
                "sessionId": session_id,
                "stopReason": idle_stop_reason,
            }),
        );
        idle_handle.window_command("hide-dictation-overlay", &serde_json::Value::Null);
    });
}

/// Follow one insertion up: a few seconds later, look once at the field it
/// landed in and see whether the user fixed a word there.
///
/// Only ever reached when `capture_insertion_anchor` already found the inserted
/// text sitting in that field, which itself only runs when the user turned the
/// setting on. Detached so the stop handler returns immediately, and written so
/// that every way this can go wrong is a silent no-op:
///
/// - the setting was turned off during the wait → nothing read;
/// - a newer dictation was delivered → nothing read (the anchor describes a
///   field the user has already moved on from);
/// - the frontmost app, the owning process or the focused element changed →
///   read, then discarded without being diffed;
/// - the field is empty, unreadable, unchanged, or no longer recognisably holds
///   the insertion → discarded.
///
/// What it produces, at most, is queued suggestions. Nothing on this path can
/// change the dictionary; only the user approving a suggestion does that.
fn schedule_post_insert_correction_readback(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    inserted_text: String,
    app_target: Option<String>,
    anchor: dictation_correction_capture::FocusedFieldFingerprint,
    delivered_at: chrono::DateTime<chrono::Utc>,
) {
    let db = Arc::clone(&state.db);
    let settings_manager = Arc::clone(&state.settings_manager);
    let recent_delivery = Arc::clone(&state.recent_dictation_delivery);
    let readback_handle = handle.clone();

    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(
            dictation_correction_capture::POST_INSERT_READBACK_WINDOW_SECS.max(0) as u64,
        ))
        .await;

        // Re-read the setting rather than trusting the value from insertion
        // time: the user may have turned it off in the seconds since, and the
        // answer to "may Plainsong read that field" has to be the current one.
        let enabled = {
            let manager = settings_manager.lock().await;
            manager
                .settings()
                .transcription
                .dictation_learn_from_external_corrections
        };

        let delivery_is_current = recent_delivery
            .lock()
            .await
            .as_ref()
            .map(|delivery| delivery.delivered_at == delivered_at)
            .unwrap_or(false);

        let known_dictionary_spoken_forms = {
            let db = db.lock().await;
            db.list_dictation_dictionary_entries()
                .map(|entries| {
                    entries
                        .into_iter()
                        .map(|entry| entry.spoken_form.to_lowercase())
                        .collect::<HashSet<_>>()
                })
                .unwrap_or_default()
        };

        let request = dictation_correction_capture::PostInsertReadbackRequest {
            enabled,
            inserted_text,
            insertion_fingerprint: anchor,
            elapsed_secs: chrono::Utc::now()
                .signed_duration_since(delivered_at)
                .num_seconds(),
            delivery_is_current,
            known_dictionary_spoken_forms,
        };

        let outcome = match tokio::task::spawn_blocking(move || {
            dictation_correction_capture::evaluate_post_insert_readback(
                &MacosFocusedFieldReader,
                &request,
            )
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(join_error) => {
                tracing::warn!(
                    "Post-insert correction readback did not complete: {}",
                    join_error
                );
                return;
            }
        };

        let candidates = match outcome {
            dictation_correction_capture::ReadbackOutcome::Candidates(candidates) => candidates,
            dictation_correction_capture::ReadbackOutcome::Aborted(abort) => {
                // Debug, not warn: every abort here is the feature working.
                tracing::debug!("Post-insert correction readback stopped: {:?}", abort);
                return;
            }
        };

        let mut queued = 0usize;
        {
            let mut db = db.lock().await;
            for candidate in &candidates {
                match db.upsert_dictation_correction_suggestion(
                    candidate.spoken_form.as_str(),
                    candidate.replacement.as_str(),
                    candidate.spoken_form.as_str(),
                    candidate.replacement.as_str(),
                    app_target.as_deref(),
                    Some(models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP),
                ) {
                    Ok(_) => queued += 1,
                    Err(error) => {
                        tracing::warn!("Queuing a correction suggestion failed: {}", error);
                    }
                }
            }
            if let Err(error) = db.prune_dictation_correction_suggestions(
                chrono::Utc::now(),
                dictation_correction_capture::CORRECTION_SUGGESTION_MAX_AGE_DAYS,
                dictation_correction_capture::CORRECTION_SUGGESTION_QUEUE_CAP,
            ) {
                tracing::warn!("Pruning stale correction suggestions failed: {}", error);
            }
        }

        if queued > 0 {
            readback_handle.emit_event(
                "dictation-correction-suggestions-changed",
                serde_json::json!({
                    "queued": queued,
                    "appTarget": app_target,
                    "source": models::CORRECTION_SUGGESTION_SOURCE_EXTERNAL_APP,
                }),
            );
        }
    });
}

fn system_audio_capability_is_verified(
    capability: &audio::system_capture::SystemAudioCapability,
) -> bool {
    capability.ready
        && capability.readiness == audio::system_capture::SystemAudioReadiness::Ready
        && capability.backend != audio::system_capture::SystemAudioBackend::None
}

fn require_verified_system_audio_for_meeting(
    capability: &audio::system_capture::SystemAudioCapability,
) -> Result<(), String> {
    if system_audio_capability_is_verified(capability) {
        return Ok(());
    }

    Err(
        "Me + Them capture is not verified ready. Run Test system audio in Setup, or start this meeting in Mic only mode."
            .to_string(),
    )
}

fn require_recording_vault_ready(
    vault_initialized: bool,
    vault_state: &VaultRuntimeState,
) -> Result<(), String> {
    if vault_initialized && (!vault_state.unlocked || vault_state.recording_key.is_none()) {
        return Err("Unlock the vault before starting a meeting".to_string());
    }
    Ok(())
}

fn recording_activation_failure_updates(
    plan: &recording_audio::RecordingCapturePlan,
    activation_error: &str,
) -> Vec<(
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
)> {
    plan.paths()
        .map(
            |(role, path)| match recording_audio::validate_plaintext_wav(path) {
                recording_audio::RecordingAudioValidation::Ready(metadata) => (
                    role,
                    recording_audio::RecordingAudioLifecycle::Failed,
                    Some(metadata),
                    Some(format!("Capture activation failed: {activation_error}")),
                ),
                recording_audio::RecordingAudioValidation::Missing(error) => (
                    role,
                    recording_audio::RecordingAudioLifecycle::Missing,
                    None,
                    Some(format!("{activation_error}; {error}")),
                ),
                recording_audio::RecordingAudioValidation::Failed(error) => (
                    role,
                    recording_audio::RecordingAudioLifecycle::Failed,
                    None,
                    Some(format!("{activation_error}; {error}")),
                ),
            },
        )
        .collect()
}

fn recording_activation_failure_has_audio(
    updates: &[(
        recording_audio::RecordingAudioRole,
        recording_audio::RecordingAudioLifecycle,
        Option<recording_audio::ValidatedRecordingAudio>,
        Option<String>,
    )],
) -> bool {
    updates
        .iter()
        .any(|(_, lifecycle, _, _)| *lifecycle != recording_audio::RecordingAudioLifecycle::Missing)
}

async fn persist_or_rollback_recording_activation_failure(
    state: &AppState,
    plan: &recording_audio::RecordingCapturePlan,
    activation_error: &str,
) {
    let updates = recording_activation_failure_updates(plan, activation_error);
    if !recording_activation_failure_has_audio(&updates) {
        let bundle = {
            let db = state.db.lock().await;
            db.load_recording_audio_bundle(&plan.recording_id)
        };
        if let Ok(bundle) = bundle {
            let deletion = remove_owned_recording_audio(&bundle, "unstarted recording rollback");
            if deletion.failures.is_empty() && deletion.cleared_roles.len() == updates.len() {
                let mut db = state.db.lock().await;
                let rollback_result = db
                    .set_audio_asset_validation_states(&plan.recording_id, &updates, "error")
                    .and_then(|_| db.delete_recording(&plan.recording_id));
                match rollback_result {
                    Ok(_) => {
                        let _ = db.log_audit_event(
                            "recording_start_rolled_back",
                            Some(serde_json::json!({
                                "recording_id": &plan.recording_id,
                                "error": activation_error,
                                "deleted_audio_files": deletion.deleted_files,
                            })),
                            "warning",
                        );
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(
                            "Failed to roll back unstarted recording '{}': {}",
                            plan.recording_id,
                            error
                        );
                    }
                }
            } else {
                tracing::warn!(
                    "Kept unstarted recording '{}' because its owned audio could not be removed: {}",
                    plan.recording_id,
                    deletion.failures.join("; ")
                );
            }
        }
    }

    let mut db = state.db.lock().await;
    if let Err(error) = db.set_audio_asset_validation_states(&plan.recording_id, &updates, "error")
    {
        tracing::error!(
            "Failed to persist activation failure for recording '{}': {}",
            plan.recording_id,
            error
        );
    }
}

/// Lifecycle for one owned asset after a stop-time failure.
///
/// A stop that fails *after* the WAV is already on disk (a vault key that went
/// away, a database write that lost a race, a join that timed out) says nothing
/// about the audio itself. This used to mark every asset `failed` regardless,
/// and nothing anywhere promotes an asset back to `ready`, so one transient
/// stop-time error permanently condemned a perfectly good meeting recording.
///
/// The file's own validation result decides the lifecycle now. Audio that still
/// reads back as a complete WAV stays `ready` and carries the stop-time error in
/// `last_error` so the failure is still recorded and visible; `failed` is
/// reserved for audio that genuinely did not survive.
fn recording_finalization_failure_update(
    role: recording_audio::RecordingAudioRole,
    validation: recording_audio::RecordingAudioValidation,
    finalization_error: &str,
) -> (
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
) {
    match validation {
        recording_audio::RecordingAudioValidation::Ready(metadata) => (
            role,
            recording_audio::RecordingAudioLifecycle::Ready,
            Some(metadata),
            Some(format!(
                "Recording finalization failed after the audio was saved: {finalization_error}"
            )),
        ),
        recording_audio::RecordingAudioValidation::Missing(error) => (
            role,
            recording_audio::RecordingAudioLifecycle::Missing,
            None,
            Some(format!("{finalization_error}; {error}")),
        ),
        recording_audio::RecordingAudioValidation::Failed(error) => (
            role,
            recording_audio::RecordingAudioLifecycle::Failed,
            None,
            Some(format!("{finalization_error}; {error}")),
        ),
    }
}

async fn persist_recording_finalization_failure(
    state: &AppState,
    recording_id: &str,
    finalization_error: &str,
) {
    let bundle = {
        let db = state.db.lock().await;
        match db.load_recording_audio_bundle(recording_id) {
            Ok(bundle) => bundle,
            Err(error) => {
                tracing::error!(
                    "Failed to load audio assets after finalization failure for '{}': {}",
                    recording_id,
                    error
                );
                return;
            }
        }
    };
    let updates = bundle
        .assets()
        .map(|asset| {
            recording_finalization_failure_update(
                asset.role,
                recording_audio::validate_plaintext_wav(&asset.path),
                finalization_error,
            )
        })
        .collect::<Vec<_>>();
    let salvageable = updates.iter().any(|(role, lifecycle, _, _)| {
        *role == recording_audio::RecordingAudioRole::Primary
            && *lifecycle == recording_audio::RecordingAudioLifecycle::Ready
    });
    let mut db = state.db.lock().await;
    if let Err(error) = db.set_audio_asset_validation_states(recording_id, &updates, "error") {
        tracing::error!(
            "Failed to persist finalization failure for recording '{}': {}",
            recording_id,
            error
        );
        return;
    }
    if salvageable {
        tracing::warn!(
            "Recording {} failed to finalize but its saved audio still validates; it stays recoverable",
            recording_id
        );
        let _ = db.log_audit_event(
            "recording_finalization_failed_audio_retained",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "error": finalization_error,
            })),
            "warning",
        );
    }
}

/// What the filesystem said about one owned asset during a re-validation pass.
///
/// Ciphertext cannot be parsed as a WAV without the vault key, so an encrypted
/// asset is only ever probed for presence. That is enough: the encryption switch
/// only ever runs on an asset that was already `ready`, so a ciphertext file that
/// is still on disk is still the ready audio it was when it was published.
#[derive(Debug, Clone, PartialEq, Eq)]
enum RecordingAudioProbe {
    Plaintext(recording_audio::RecordingAudioValidation),
    Encrypted { present: bool },
}

/// Repair one asset's lifecycle from what is actually on disk right now.
///
/// This is the only path that can move an asset out of `failed`. Without it a
/// stop-time or startup failure was permanent for the life of the recording.
fn revalidated_recording_audio_update(
    role: recording_audio::RecordingAudioRole,
    probe: RecordingAudioProbe,
) -> (
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
) {
    match probe {
        RecordingAudioProbe::Plaintext(recording_audio::RecordingAudioValidation::Ready(
            metadata,
        )) => (
            role,
            recording_audio::RecordingAudioLifecycle::Ready,
            Some(metadata),
            None,
        ),
        RecordingAudioProbe::Plaintext(recording_audio::RecordingAudioValidation::Missing(
            error,
        )) => (
            role,
            recording_audio::RecordingAudioLifecycle::Missing,
            None,
            Some(error),
        ),
        RecordingAudioProbe::Plaintext(recording_audio::RecordingAudioValidation::Failed(
            error,
        )) => (
            role,
            recording_audio::RecordingAudioLifecycle::Failed,
            None,
            Some(error),
        ),
        RecordingAudioProbe::Encrypted { present: true } => (
            role,
            recording_audio::RecordingAudioLifecycle::Ready,
            None,
            None,
        ),
        RecordingAudioProbe::Encrypted { present: false } => (
            role,
            recording_audio::RecordingAudioLifecycle::Missing,
            None,
            Some("Encrypted audio file is absent".to_string()),
        ),
    }
}

fn probe_recording_audio_asset(
    asset: &recording_audio::RecordingAudioAsset,
) -> RecordingAudioProbe {
    match asset.protection {
        recording_audio::RecordingAudioProtection::Plaintext => {
            RecordingAudioProbe::Plaintext(recording_audio::validate_plaintext_wav(&asset.path))
        }
        recording_audio::RecordingAudioProtection::Encrypted => RecordingAudioProbe::Encrypted {
            present: asset.path.is_file(),
        },
    }
}

fn revalidated_recording_audio_updates(
    bundle: &recording_audio::RecordingAudioBundle,
) -> Vec<(
    recording_audio::RecordingAudioRole,
    recording_audio::RecordingAudioLifecycle,
    Option<recording_audio::ValidatedRecordingAudio>,
    Option<String>,
)> {
    bundle
        .assets()
        .map(|asset| {
            revalidated_recording_audio_update(asset.role, probe_recording_audio_asset(asset))
        })
        .collect()
}

fn revalidated_recording_audio_is_recoverable(
    updates: &[(
        recording_audio::RecordingAudioRole,
        recording_audio::RecordingAudioLifecycle,
        Option<recording_audio::ValidatedRecordingAudio>,
        Option<String>,
    )],
) -> bool {
    !updates.is_empty()
        && updates.iter().all(|(_, lifecycle, _, _)| {
            *lifecycle == recording_audio::RecordingAudioLifecycle::Ready
        })
}

/// Re-read every owned audio file for one meeting and repair its lifecycle rows.
///
/// This is the user-reachable half of the repair: a meeting whose assets were
/// condemned by a stop-time failure has intact audio on disk but rows that say
/// otherwise, and every runtime resolver refuses anything that is not `ready`.
/// Before this command the only escape was to relaunch the app and hope the
/// startup reconcile covered it, which it did not for a recording already parked
/// in `error`.
///
/// The recording's own status is deliberately left alone. Re-validating audio is
/// evidence about files, not about whether the meeting was transcribed; the user
/// re-transcribes from here if the audio came back ready.
async fn revalidate_recording_audio_for_sidecar(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
) -> Result<serde_json::Value, String> {
    let _storage_guard = state.audio_storage_gate.try_lock().map_err(|_| {
        "Recording storage is busy with encryption, backup, deletion, or retention. Try again shortly."
            .to_string()
    })?;

    let recording = {
        let db = state.db.lock().await;
        db.get_recording(recording_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Meeting '{recording_id}' was not found."))?
    };
    if matches!(recording.status.as_str(), "recording" | "processing") {
        return Err(
            "Wait for this meeting to finish capturing and processing before re-checking its audio."
                .to_string(),
        );
    }

    let bundle = {
        let db = state.db.lock().await;
        db.load_recording_audio_bundle(recording_id)
            .map_err(|error| error.to_string())?
    };
    let updates = revalidated_recording_audio_updates(&bundle);
    if updates.is_empty() {
        return Err(format!(
            "Meeting '{recording_id}' no longer owns any audio files to re-check."
        ));
    }
    let recoverable = revalidated_recording_audio_is_recoverable(&updates);
    let repaired_duration = updates
        .iter()
        .find(|(role, _, _, _)| *role == recording_audio::RecordingAudioRole::Primary)
        .and_then(|(_, _, metadata, _)| metadata.as_ref())
        .map(|metadata| metadata.duration_seconds)
        .filter(|duration| *duration > 0);
    let assets = updates
        .iter()
        .map(|(role, lifecycle, _, last_error)| {
            serde_json::json!({
                "role": role.as_str(),
                "lifecycle": lifecycle.as_str(),
                "error": last_error,
            })
        })
        .collect::<Vec<_>>();

    {
        let mut db = state.db.lock().await;
        db.repair_audio_asset_lifecycles(recording_id, &updates, None)
            .map_err(|error| error.to_string())?;
        // A finalization failure can land before the duration was ever written,
        // so a repaired meeting would otherwise read as 0 seconds forever.
        if recording.duration <= 0 {
            if let Some(duration) = repaired_duration {
                if let Err(error) = db.update_recording_duration(recording_id, duration) {
                    tracing::warn!(
                        "Repaired audio for {} but its duration could not be written: {}",
                        recording_id,
                        error
                    );
                }
            }
        }
        let _ = db.log_audit_event(
            "recording_audio_revalidated",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "recoverable": recoverable,
                "assets": &assets,
            })),
            if recoverable { "info" } else { "warning" },
        );
    }

    let message = if recoverable {
        "Saved meeting audio was re-checked and is intact. Re-transcribe this meeting to finish it."
    } else {
        "Saved meeting audio was re-checked and some of it could not be read."
    };
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": recording_id,
            "status": &recording.status,
            "message": message,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );

    Ok(serde_json::json!({
        "recordingId": recording_id,
        "recoverable": recoverable,
        "message": message,
        "assets": assets,
    }))
}

/// Sidecar-compatible start_recording. Emits state events via SidecarHandle.
/// Overlay show/hide and tray updates are handled by Electron.
/// Verify that this capture was asked for by a real user gesture.
///
/// The nonce used to be validated only as a UUID, which made the check a
/// formality: anything that could reach the command could mint a well-formed
/// proof for itself. It is now redeemed against the registry the privileged
/// Electron side writes to, single use and short lived.
fn authorize_meeting_capture_options(
    capture_admission: &admission::CaptureAdmissionRegistry,
    mut options: models::RecordingOptions,
) -> Result<models::RecordingOptions, String> {
    let nonce = options
        .admission_nonce
        .take()
        .ok_or("Meeting capture requires privileged Electron admission")?;
    uuid::Uuid::parse_str(&nonce)
        .map_err(|_| "Meeting capture admission proof is invalid".to_string())?;

    capture_admission
        .consume(&nonce)
        .map_err(|rejection| rejection.message().to_string())?;

    // Reaching here means a privileged gesture stands behind this capture, which
    // is exactly what the consent prompt attests to.
    options.consent_prompt_shown = true;
    Ok(options)
}

/// Why a meeting failed to start, as a value the renderer can branch on.
///
/// The renderer used to substring-match the error text to decide what advice to
/// show, which quietly broke every time a message was reworded and could never
/// distinguish two failures that happened to share a phrase. These codes are the
/// stable contract; the human-readable message travels alongside, unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MeetingStartErrorCode {
    MicPermissionDenied,
    SystemAudioUnavailable,
    AudioDeviceNotFound,
    SidecarUnavailable,
    DiskFull,
    AlreadyRecording,
    ConsentRequired,
    Unknown,
}

impl MeetingStartErrorCode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::MicPermissionDenied => "mic_permission_denied",
            Self::SystemAudioUnavailable => "system_audio_unavailable",
            Self::AudioDeviceNotFound => "audio_device_not_found",
            Self::SidecarUnavailable => "sidecar_unavailable",
            Self::DiskFull => "disk_full",
            Self::AlreadyRecording => "already_recording",
            Self::ConsentRequired => "consent_required",
            Self::Unknown => "unknown",
        }
    }
}

/// Whether a meeting-start failure was really "the disk is full".
///
/// Text matching, because the failure arrives as a flattened `anyhow` chain by
/// the time it reaches the start path and the original `io::Error` (with its
/// `ENOSPC`) is no longer reachable. This classifier exists precisely so the
/// *renderer* never has to do this: the guesswork stays on one line here, behind
/// a typed code, instead of being spread across UI branches that silently stop
/// matching whenever a message is reworded.
fn meeting_start_failure_is_out_of_space(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    // "disk space" is the fragment that catches the capture preflight's own
    // refusal ("Not enough free disk space to record a meeting..."), along with
    // "insufficient disk space" and "out of disk space". Matching the narrower
    // "not enough space" alone missed it.
    normalized.contains("no space left")
        || normalized.contains("not enough space")
        || normalized.contains("insufficient space")
        || normalized.contains("disk space")
        || normalized.contains("disk is full")
        || normalized.contains("free space")
}

/// Announce a meeting-start failure with its typed code, and hand back the
/// human-readable message for the command's `Err`.
///
/// Failures before the recording row exists have no id yet, so `recording_id` is
/// optional; the phase event still carries the code so the renderer can explain
/// the failure without parsing prose.
fn fail_meeting_start(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: Option<&str>,
    code: MeetingStartErrorCode,
    message: String,
) -> String {
    if let Some(recording_id) = recording_id {
        if let Ok(mut overlay) = state.recording_overlay_state.lock() {
            overlay.phase = "error".to_string();
            overlay.dismissed = false;
            overlay.recording_id = Some(recording_id.to_string());
            overlay.message = Some(message.clone());
        }
    }
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "error",
            "recordingId": recording_id,
            "code": code.as_str(),
            "message": &message,
        }),
    );
    // The returned string is what reaches the renderer as the command's error.
    // JSON-RPC carries only a message there, so the typed code rides in a
    // machine-readable prefix that the Electron bridge lifts back onto
    // `error.code` -- the same `PREFIX:` convention `SIDECAR_DUPLICATE:`
    // already uses. Callers that persist or log the failure use `message`
    // directly, before this point, so nothing stores the prefix.
    format!(
        "{}{}:{}",
        MEETING_START_FAILURE_PREFIX,
        code.as_str(),
        message
    )
}

/// Marks a meeting-start error as carrying a typed code.
///
/// Wire form: `MEETING_START_FAILED:<code>:<human message>`.
const MEETING_START_FAILURE_PREFIX: &str = "MEETING_START_FAILED:";

fn emit_meeting_lifecycle_phase(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    phase: &str,
    recording_id: &str,
    message: Option<&str>,
) {
    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.phase = phase.to_string();
        overlay.dismissed = false;
        overlay.recording_id = Some(recording_id.to_string());
        overlay.message = message.map(str::to_string);
    }
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": phase,
            "recordingId": recording_id,
            "message": message,
        }),
    );
}

fn meeting_stop_is_already_terminal_or_processing(status: &str) -> bool {
    matches!(status, "processing" | "completed" | "error")
}

async fn start_recording_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    mut options: models::RecordingOptions,
) -> Result<String, String> {
    {
        let dictation_state = state.dictation_runtime_state.lock().await;
        if *dictation_state != DictationSessionState::Idle {
            return Err(fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::AlreadyRecording,
                "Cannot start recording while dictation is active".to_string(),
            ));
        }
    }
    let capture_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::Capture)
        .map_err(|error| {
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::AlreadyRecording,
                error,
            )
        })?;
    let _storage_guard = state.audio_storage_gate.try_lock().map_err(|_| {
        fail_meeting_start(
            state,
            handle,
            None,
            MeetingStartErrorCode::AlreadyRecording,
            "Recording storage is busy with encryption, backup, deletion, or retention. Try again shortly."
                .to_string(),
        )
    })?;

    let settings_snapshot = state.settings_manager.lock().await.settings().clone();
    let meeting_selection = resolve_ready_meeting_selection(
        state,
        &settings_snapshot.transcription,
        settings_snapshot.privacy.remote_processing_enabled,
    )
    .await
    .map_err(|error| {
        // The transcription route is unusable: no model, no runtime, or a
        // remote route the privacy settings forbid.
        fail_meeting_start(
            state,
            handle,
            None,
            MeetingStartErrorCode::SidecarUnavailable,
            error,
        )
    })?;

    #[cfg(target_os = "macos")]
    if options.mic {
        ensure_microphone_permission(
            settings_snapshot
                .transcription
                .dictation_auto_request_permissions,
        )
        .map_err(|error| {
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::MicPermissionDenied,
                format!("Microphone permission is not ready. {}", error),
            )
        })?;
    }

    ensure_asr_route_ready(
        state,
        meeting_selection.0,
        &meeting_selection.1,
        "meeting transcription",
    )
    .await
    .map_err(|error| {
        fail_meeting_start(
            state,
            handle,
            None,
            MeetingStartErrorCode::SidecarUnavailable,
            error,
        )
    })?;

    if options.system_audio {
        let capability = {
            let audio = state.audio_capture.lock().await;
            audio.system_audio_capability()
        };
        require_verified_system_audio_for_meeting(&capability).map_err(|error| {
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::SystemAudioUnavailable,
                error,
            )
        })?;
    }

    if options.mic && options.preferred_input_device_id.is_none() {
        let settings = state.settings_manager.lock().await.settings().clone();
        options.preferred_input_device_id = settings
            .audio
            .meeting_input_device
            .as_ref()
            .filter(|_| settings.audio.meeting_input_override_enabled)
            .or(settings.audio.preferred_input_device.as_ref())
            .map(|device| device.device_id.clone());
    }

    {
        let vault_state = state.vault_state.lock().await;
        require_recording_vault_ready(settings_snapshot.privacy.vault_initialized, &vault_state)
            .map_err(|error| {
                fail_meeting_start(
                    state,
                    handle,
                    None,
                    MeetingStartErrorCode::ConsentRequired,
                    error,
                )
            })?;
    }

    let plan = {
        let audio = state.audio_capture.lock().await;
        audio.plan_recording(&options).map_err(|error| {
            // Planning fails when neither capture source is usable, which is a
            // device problem rather than a permission or capability one.
            fail_meeting_start(
                state,
                handle,
                None,
                MeetingStartErrorCode::AudioDeviceNotFound,
                error.to_string(),
            )
        })?
    };
    let recording_id = plan.recording_id.clone();
    let recording = models::Recording {
        id: recording_id.clone(),
        title: format!(
            "Meeting - {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M")
        ),
        project_id: options.project_id.clone(),
        duration: 0,
        created_at: chrono::Utc::now(),
        updated_at: chrono::Utc::now(),
        source_type: "meeting".to_string(),
        audio_path: plan.primary_path.to_string_lossy().to_string(),
        status: "recording".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: options
            .meeting_notes
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        meeting_template_id: options.template.clone(),
        meeting_capture_mode: Some(options.meeting_capture_mode.clone().unwrap_or_else(|| {
            if options.system_audio {
                "me_and_them".to_string()
            } else {
                "mic_only".to_string()
            }
        })),
        // Recorded here, never imported.
        imported_source_name: None,
        notes_updated_at: options
            .meeting_notes
            .as_ref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|_| chrono::Utc::now()),
        consent_prompt_shown: options.consent_prompt_shown,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        attendees: Vec::new(),
        pause_spans: Vec::new(),
        video_service: models::known_video_service(options.video_service.as_deref()),
    };

    {
        let mut db = state.db.lock().await;
        db.create_recording_with_audio_plan(&recording, &plan)
            .map_err(|error| {
                let message = error.to_string();
                // The capture preflight refuses here when there is not enough
                // room to hold the recording, which is the one failure the user
                // can fix directly.
                let code = if meeting_start_failure_is_out_of_space(&message) {
                    MeetingStartErrorCode::DiskFull
                } else {
                    MeetingStartErrorCode::Unknown
                };
                fail_meeting_start(state, handle, Some(&recording_id), code, message)
            })?;
    }

    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.phase = "preparing".to_string();
        overlay.dismissed = false;
        overlay.recording_id = Some(recording_id.clone());
        overlay.started_at_ms = None;
        overlay.system_audio_active = Some(options.system_audio);
        overlay.consent_prompt_shown = Some(options.consent_prompt_shown);
        overlay.message = Some("Preparing meeting audio capture".to_string());
    }
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "preparing",
            "recordingId": &recording_id,
            "systemAudioActive": options.system_audio,
            "consentPromptShown": options.consent_prompt_shown,
            "message": "Preparing meeting audio capture",
        }),
    );

    let preparation_result = {
        let mut audio = state.audio_capture.lock().await;
        audio.start_recording(plan.clone(), options.clone(), Some(handle.clone()))
    };
    if let Err(error) = preparation_result {
        let message = error.to_string();
        persist_or_rollback_recording_activation_failure(state, &plan, &message).await;
        // Opening the capture devices is where a missing or busy input device
        // shows up, and where a full disk first refuses to create the WAV.
        let code = if meeting_start_failure_is_out_of_space(&message) {
            MeetingStartErrorCode::DiskFull
        } else {
            MeetingStartErrorCode::AudioDeviceNotFound
        };
        return Err(fail_meeting_start(
            state,
            handle,
            Some(&recording_id),
            code,
            message,
        ));
    }

    if let Err(error) = {
        let mut db = state.db.lock().await;
        db.mark_audio_assets_writing(&recording_id)
    } {
        let message = format!("Failed to mark recording audio writers active: {error}");
        {
            let mut audio = state.audio_capture.lock().await;
            audio.abort_prepared_recording();
        }
        persist_or_rollback_recording_activation_failure(state, &plan, &message).await;
        let code = if meeting_start_failure_is_out_of_space(&message) {
            MeetingStartErrorCode::DiskFull
        } else {
            MeetingStartErrorCode::Unknown
        };
        return Err(fail_meeting_start(
            state,
            handle,
            Some(&recording_id),
            code,
            message,
        ));
    }

    let activation_result = {
        let mut audio = state.audio_capture.lock().await;
        audio.activate_recording(&recording_id)
    };
    if let Err(error) = activation_result {
        let message = error.to_string();
        persist_or_rollback_recording_activation_failure(state, &plan, &message).await;
        let code = if meeting_start_failure_is_out_of_space(&message) {
            MeetingStartErrorCode::DiskFull
        } else {
            MeetingStartErrorCode::AudioDeviceNotFound
        };
        return Err(fail_meeting_start(
            state,
            handle,
            Some(&recording_id),
            code,
            message,
        ));
    }
    *state.active_capture_lease.lock().await = Some((recording_id.clone(), capture_lease));

    let maybe_stream_info = {
        let audio = state.audio_capture.lock().await;
        audio.get_streaming_queue(&recording_id)
    };

    {
        let mut db = state.db.lock().await;
        if let Some(ref template) = options.template {
            if let Ok(mut templates) = state.recording_templates.lock() {
                templates.insert(recording_id.clone(), template.clone());
            }
        }

        let details = serde_json::json!({
            "recording_id": &recording_id,
            "project_id": &options.project_id,
            "mic_enabled": options.mic,
            "system_audio_enabled": options.system_audio
        });
        if let Err(error) = db.log_audit_event("recording_started", Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", error);
        }

        if options.consent_prompt_shown {
            // Plainsong shows the notice and copies it on request; it never
            // posts it, so the recorded mode is always manual.
            let status = meeting_consent_notice_status(state);
            let _ = db.update_recording_consent_state(
                &recording_id,
                true,
                Some(MEETING_CONSENT_NOTICE_MODE_MANUAL),
                status.surface.as_deref(),
                Some(status.message.as_str()),
            );
        } else {
            let _ = db.update_recording_consent_state(&recording_id, false, None, None, None);
        }
    }

    if let Some((stream_queue, sample_rate)) = maybe_stream_info {
        state.recording_stream_stop.store(false, Ordering::SeqCst);
        let stop_flag = Arc::clone(&state.recording_stream_stop);
        let streaming_transcriber = Arc::clone(&state.streaming_transcriber);
        let streaming_provider = meeting_selection.0;
        let streaming_model_id = meeting_selection.1.clone();
        let emit_handle = handle.clone();
        let rec_id = recording_id.clone();
        tokio::spawn(async move {
            let session_result = streaming_transcriber
                .start_session(streaming_provider, sample_rate, streaming_model_id)
                .await;
            let (session_id, mut result_rx) = match session_result {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!("Failed to start live streaming session: {}", e);
                    return;
                }
            };
            let emit_inner = emit_handle.clone();
            let emit_rec_id = rec_id.clone();
            let recv_task = tokio::spawn(async move {
                while let Some(result) = result_rx.recv().await {
                    if !should_emit_streaming_result(&result) {
                        continue;
                    }
                    emit_inner.emit_event(
                        "recording-transcription-stream",
                        streaming_stream_event_payload(&emit_rec_id, &result),
                    );
                }
            });
            let chunk_threshold = (sample_rate as usize) / 2;
            let mut pending: Vec<f32> = Vec::with_capacity(chunk_threshold * 2);
            while !stop_flag.load(Ordering::SeqCst) {
                while let Some(chunk) = stream_queue.pop() {
                    pending.extend_from_slice(&chunk);
                }
                if pending.len() >= chunk_threshold {
                    let feed_slice = std::mem::take(&mut pending);
                    if let Err(e) = streaming_transcriber
                        .feed_audio(&session_id, &feed_slice)
                        .await
                    {
                        tracing::warn!("Live streaming feed error: {}", e);
                    }
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            while let Some(chunk) = stream_queue.pop() {
                pending.extend_from_slice(&chunk);
            }
            if !pending.is_empty() {
                let _ = streaming_transcriber
                    .feed_audio(&session_id, &pending)
                    .await;
            }
            let _ = streaming_transcriber.finalize_session(&session_id).await;
            // Finalizing drops the session's sender, so the receiver loop ends
            // on its own. Await it rather than aborting: the closing segment is
            // already in the channel and aborting would drop it in flight.
            if tokio::time::timeout(Duration::from_secs(5), recv_task)
                .await
                .is_err()
            {
                tracing::warn!("Live streaming receiver did not drain within 5s");
            }
        });
    }

    let started_at_ms = chrono::Utc::now().timestamp_millis();

    // Update recording_overlay_state so get_recording_overlay_state returns the correct snapshot.
    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.phase = "recording".to_string();
        overlay.dismissed = false;
        overlay.recording_id = Some(recording_id.clone());
        overlay.started_at_ms = Some(started_at_ms);
        overlay.system_audio_active = Some(options.system_audio);
        overlay.consent_prompt_shown = Some(options.consent_prompt_shown);
        overlay.message = None;
        overlay.paused = false;
        overlay.closed_paused_ms = 0;
        overlay.pause_started_at_ms = None;
    }

    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "recording", "recordingId": &recording_id,
            "startedAtMs": started_at_ms,
            "systemAudioActive": options.system_audio,
            "consentPromptShown": options.consent_prompt_shown,
        }),
    );
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": &recording_id, "status": "recording",
            "updatedAt": chrono::Utc::now().to_rfc3339(),
            "consentPromptShown": options.consent_prompt_shown,
        }),
    );

    // Tell Electron to show the recording overlay window.
    handle.window_command("show-recording-overlay", &serde_json::Value::Null);

    spawn_meeting_capture_monitor(
        Arc::clone(state),
        handle.clone(),
        recording_id.clone(),
        options.detected_call_id,
    );

    Ok(recording_id)
}

/// How often a running meeting's capture health and free disk space are polled.
///
/// Fast enough that a dead writer surfaces while there is still a meeting to
/// salvage, slow enough that the `statvfs` and the audio-capture lock are noise
/// next to the capture threads themselves.
const MEETING_CAPTURE_MONITOR_INTERVAL: Duration = Duration::from_secs(5);

/// Pause or resume the active meeting on behalf of a renderer.
///
/// The capture streams are not touched (see `AudioCapture::pause_recording`);
/// what changes here is everything that reads the pause: the overlay snapshot
/// a reopened window hydrates from, the lifecycle event every live window
/// listens to, and the audit log.
async fn set_recording_paused_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
    pause: bool,
) -> Result<serde_json::Value, String> {
    let snapshot = {
        let mut audio = state.audio_capture.lock().await;
        if pause {
            audio.pause_recording(recording_id)
        } else {
            audio.resume_recording(recording_id)
        }
    }
    .map_err(|error| error.to_string())?;

    if let Ok(mut overlay) = state.recording_overlay_state.lock() {
        overlay.paused = snapshot.paused;
        overlay.closed_paused_ms = snapshot.closed_paused_ms;
        overlay.pause_started_at_ms = snapshot.pause_started_at_ms;
    }
    // Phase stays `recording`: capture is still the live session, the device
    // is still held, and the renderer's reducer keys everything else off the
    // pause fields. A new phase would put every window into a state nothing
    // renders.
    handle.emit_event(
        "meeting-recording-state-changed",
        serde_json::json!({
            "phase": "recording",
            "recordingId": recording_id,
            "paused": snapshot.paused,
            "closedPausedMs": snapshot.closed_paused_ms,
            "pauseStartedAtMs": snapshot.pause_started_at_ms,
        }),
    );
    {
        let mut db = state.db.lock().await;
        // Written on every pause and resume, not only at stop: the audio file
        // skips the pauses, so these spans are the only record of where the
        // gaps are, and a crash mid-meeting used to lose all of them. The
        // ledger is small and the DB lock is already held for the audit event.
        // A failure costs the timeline markers and nothing else, so it does
        // not fail the pause.
        if let Err(error) = db.set_recording_pause_spans(recording_id, &snapshot.spans) {
            tracing::warn!(
                "Failed to persist pause spans for {}: {}",
                recording_id,
                error
            );
        }
        let details = serde_json::json!({
            "recording_id": recording_id,
            "pause_count": snapshot.spans.len(),
            "at_seconds": snapshot.spans.last().map(|span| span.at_seconds),
            "closed_paused_ms": snapshot.closed_paused_ms,
        });
        let event = if pause {
            "recording_paused"
        } else {
            "recording_resumed"
        };
        if let Err(error) = db.log_audit_event(event, Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", error);
        }
    }
    serde_json::to_value(snapshot).map_err(|error| error.to_string())
}

/// Why the capture monitor ended a meeting on its own.
enum MeetingAutoStopReason {
    CallEnded { app: &'static str },
    Silence { minutes: u32 },
}

/// End a running meeting for `reason`, saying so on every surface first.
///
/// The `meeting-auto-stopped` event goes out before the stop so the shell can
/// post its notification against a meeting that is still the active one; the
/// stop itself is the ordinary stop path, so the audio lands, is hashed, and
/// goes to transcription exactly as a click on Stop would have it.
async fn auto_stop_meeting(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
    reason: MeetingAutoStopReason,
) {
    let (reason_key, message, app, silence_minutes) = match reason {
        MeetingAutoStopReason::CallEnded { app } => (
            "call_ended",
            format!("{app} closed, so Plainsong stopped the meeting and is saving what it captured."),
            Some(app),
            None,
        ),
        MeetingAutoStopReason::Silence { minutes } => (
            "silence",
            format!("Nothing audible for {minutes} minutes, so Plainsong stopped the meeting and is saving what it captured."),
            None,
            Some(minutes),
        ),
    };
    tracing::info!("Auto-stopping meeting {}: {}", recording_id, message);
    handle.emit_event(
        "meeting-auto-stopped",
        serde_json::json!({
            "recordingId": recording_id,
            "reason": reason_key,
            "app": app,
            "silenceMinutes": silence_minutes,
            "message": &message,
        }),
    );
    emit_meeting_capture_warning(state.as_ref(), handle, recording_id, &message);
    {
        let mut db = state.db.lock().await;
        let _ = db.log_audit_event(
            "recording_auto_stopped",
            Some(serde_json::json!({
                "recording_id": recording_id,
                "reason": reason_key,
                "app": app,
                "silence_minutes": silence_minutes,
            })),
            "info",
        );
    }
    if let Err(error) = stop_recording_for_sidecar(state, handle, recording_id.to_string()).await {
        tracing::error!(
            "Failed to auto-stop meeting {} ({}): {}",
            recording_id,
            reason_key,
            error
        );
    }
}

/// How often the running applications are looked at for a live call.
const MEETING_CALL_DETECTION_INTERVAL: Duration = Duration::from_secs(5);

#[cfg(target_os = "macos")]
fn accessibility_granted_for_call_detection() -> bool {
    check_accessibility_permission()
}

#[cfg(not(target_os = "macos"))]
fn accessibility_granted_for_call_detection() -> bool {
    false
}

async fn meeting_call_status_for_sidecar(state: &AppState) -> serde_json::Value {
    let enabled = state
        .settings_manager
        .lock()
        .await
        .settings()
        .meetings
        .call_detection_enabled;
    let active_call = state
        .meeting_call_detector
        .lock()
        .ok()
        .and_then(|detector| detector.active().cloned());
    let status = meeting_detect::MeetingCallStatus {
        supported: cfg!(target_os = "macos"),
        enabled,
        accessibility_granted: accessibility_granted_for_call_detection(),
        active_call,
    };
    serde_json::to_value(status).unwrap_or(serde_json::Value::Null)
}

fn emit_meeting_call_ended(
    handle: &crate::sidecar_handle::SidecarHandle,
    call: &meeting_detect::ActiveCall,
    reason: meeting_detect::CallEndReason,
) {
    let mut payload = serde_json::to_value(call).unwrap_or_default();
    if let serde_json::Value::Object(map) = &mut payload {
        map.insert(
            "reason".to_string(),
            serde_json::to_value(reason).unwrap_or_default(),
        );
        map.insert(
            "endedAt".to_string(),
            serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
        );
    }
    tracing::info!(
        "Detected {} call {} ended ({:?})",
        call.app_label,
        call.call_id,
        reason
    );
    handle.emit_event("meeting-call-ended", payload);
}

/// One poll's worth of evidence, gathered off the async runtime because the
/// Accessibility reads can block on an unresponsive app.
#[cfg(target_os = "macos")]
async fn sample_call_detection(state: &AppState) -> Option<meeting_detect::DetectorSample> {
    // While Plainsong itself holds the microphone, "the input device is open
    // somewhere" is true because of us, and says nothing about anyone else.
    let self_holds_microphone = {
        let audio = state.audio_capture.lock().await;
        audio.is_dictating() || audio.is_recording() || audio.is_hands_free_monitor_active()
    };
    let accessibility_granted = check_accessibility_permission();
    // The browser whose window a call was already found in, so this poll can
    // still see that window close. Every other browser is left alone unless
    // the microphone says something is going on — reading a Chromium browser's
    // windows switches it into full accessibility mode for good.
    let active_call_bundle_id = state
        .meeting_call_detector
        .lock()
        .ok()
        .and_then(|detector| detector.active().map(|call| call.bundle_id.clone()));
    tokio::task::spawn_blocking(move || {
        // The microphone answer comes first: it is what decides whether this
        // poll touches Accessibility at all.
        let mic_running_elsewhere = if self_holds_microphone {
            None
        } else {
            meeting_detect::default_input_device_running_somewhere()
        };
        let apps = meeting_detect::sample_running_apps(
            accessibility_granted,
            mic_running_elsewhere,
            active_call_bundle_id.as_deref(),
        );
        meeting_detect::DetectorSample {
            apps,
            mic_running_elsewhere,
        }
    })
    .await
    .ok()
}

#[cfg(not(target_os = "macos"))]
async fn sample_call_detection(_state: &AppState) -> Option<meeting_detect::DetectorSample> {
    None
}

/// Watch for a live call and say so. Never starts a recording: every event
/// this emits ends in an offer the user has to accept.
///
/// Reads the setting on every pass so turning detection off takes effect
/// within one interval, and reports the call it was tracking as ended for
/// that reason — which no auto-stop acts on.
pub fn spawn_meeting_call_detection(
    state: Arc<AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(MEETING_CALL_DETECTION_INTERVAL).await;
            if state.sidecar_shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let enabled = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .call_detection_enabled;
            if !enabled || !cfg!(target_os = "macos") {
                let cleared = state
                    .meeting_call_detector
                    .lock()
                    .ok()
                    .and_then(|mut detector| detector.clear());
                if let Some(call) = cleared {
                    emit_meeting_call_ended(
                        &handle,
                        &call,
                        meeting_detect::CallEndReason::DetectionDisabled,
                    );
                }
                continue;
            }
            let Some(sample) = sample_call_detection(state.as_ref()).await else {
                continue;
            };
            let now_ms = chrono::Utc::now().timestamp_millis();
            let event = state
                .meeting_call_detector
                .lock()
                .ok()
                .and_then(|mut detector| detector.observe(&sample, now_ms));
            match event {
                Some(meeting_detect::DetectorEvent::Detected(call)) => {
                    tracing::info!(
                        "Detected a {} call ({:?} confidence)",
                        call.app_label,
                        call.confidence
                    );
                    handle.emit_event("meeting-call-detected", &call);
                }
                Some(meeting_detect::DetectorEvent::Ended { call, reason }) => {
                    emit_meeting_call_ended(&handle, &call, reason);
                }
                None => {}
            }
        }
    });
}

/// Announce a mid-meeting problem on both channels the user can actually see.
///
/// The lifecycle event deliberately re-asserts the `recording` phase rather than
/// inventing a new one: capture really is still running, and the renderer's
/// lifecycle reducer only understands the phases it already has — an unknown
/// phase would put the overlay into a state nothing renders. The message is what
/// carries the news.
fn emit_meeting_capture_warning(
    state: &AppState,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: &str,
    message: &str,
) {
    tracing::error!("Meeting {} capture warning: {}", recording_id, message);
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": recording_id,
            "status": "warning",
            "message": message,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );
    emit_meeting_lifecycle_phase(state, handle, "recording", recording_id, Some(message));
}

/// Watch a running meeting's writer threads and the disk they are writing to.
///
/// Nothing else notices a WAV writer that died: the mic-only capture callback
/// discards every later sample through its `Disconnected` arm without a word,
/// the mixed path just shuts capture down, and the overlay keeps showing an
/// active recording either way. The user found out at stop, by which point the
/// meeting was over. This loop is what makes both failures visible while there
/// is still something to salvage.
fn spawn_meeting_capture_monitor(
    state: Arc<AppState>,
    handle: crate::sidecar_handle::SidecarHandle,
    recording_id: String,
    detected_call_id: Option<u64>,
) {
    // The call this meeting is recorded alongside: the one whose offer the
    // reader accepted, and only that one. Bound once, by exact id — a call
    // that merely happens to be live when capture begins is somebody else's
    // call, and its ending must not end this meeting.
    let bound_call = state
        .meeting_call_detector
        .lock()
        .ok()
        .and_then(|detector| {
            meeting_detect::bind_detected_call(detector.active(), detected_call_id)
        });
    tokio::spawn(async move {
        let mut writer_failure_reported = false;
        let mut low_space_reported = false;
        let mut silence_warning_reported = false;
        loop {
            tokio::time::sleep(MEETING_CAPTURE_MONITOR_INTERVAL).await;

            let health = {
                let audio = state.audio_capture.lock().await;
                audio.recording_capture_health(&recording_id)
            };
            // `None` means this recording is no longer the live session, which
            // is the loop's exit condition — stop already reports everything.
            let Some(health) = health else {
                return;
            };

            let meetings_settings = state
                .settings_manager
                .lock()
                .await
                .settings()
                .meetings
                .clone();
            if let Some((call_id, app)) = bound_call {
                let ended = state
                    .meeting_call_detector
                    .lock()
                    .ok()
                    .and_then(|detector| detector.ended_reason(call_id));
                if meeting_detect::auto_stop_for_call_end(
                    meetings_settings.auto_stop_when_call_app_quits,
                    ended,
                ) {
                    auto_stop_meeting(
                        &state,
                        &handle,
                        &recording_id,
                        MeetingAutoStopReason::CallEnded { app },
                    )
                    .await;
                    return;
                }
            }
            let silence_minutes = meetings_settings.auto_stop_after_silence_minutes;
            if audio::silence_auto_stop_due(&health, silence_minutes) {
                auto_stop_meeting(
                    &state,
                    &handle,
                    &recording_id,
                    MeetingAutoStopReason::Silence {
                        minutes: silence_minutes,
                    },
                )
                .await;
                return;
            }
            // Said at half the fuse rather than only as the meeting ends: the
            // threshold is a heuristic about room tone, and a quiet lecture
            // deserves the chance to answer it while there is still a meeting
            // to save. Re-arms whenever sound comes back, so a second quiet
            // stretch is announced too.
            if let Some(warn_after) = audio::silence_auto_stop_warning_minutes(silence_minutes) {
                if audio::silence_auto_stop_warning_due(&health, silence_minutes) {
                    if !silence_warning_reported {
                        silence_warning_reported = true;
                        emit_meeting_capture_warning(
                            state.as_ref(),
                            &handle,
                            &recording_id,
                            &format!(
                                "No audio for {warn_after} minutes; Plainsong stops this meeting in {} unless sound resumes.",
                                silence_minutes - warn_after
                            ),
                        );
                    }
                } else {
                    silence_warning_reported = false;
                }
            }

            if !writer_failure_reported {
                if let Some(reason) = health.writer_failure.as_deref() {
                    writer_failure_reported = true;
                    emit_meeting_capture_warning(
                        state.as_ref(),
                        &handle,
                        &recording_id,
                        &format!(
                            "Plainsong stopped being able to save this meeting's audio, so nothing recorded from now on is kept. Stop the meeting to keep what was already saved. ({reason})"
                        ),
                    );
                    let mut db = state.db.lock().await;
                    let _ = db.log_audit_event(
                        "recording_writer_failed",
                        Some(serde_json::json!({
                            "recording_id": &recording_id,
                            "error": reason,
                        })),
                        "error",
                    );
                }
            }

            // Fails open: an unmeasurable volume must not end a meeting.
            let Some(available) = ({
                let audio = state.audio_capture.lock().await;
                audio.recordings_available_space_bytes()
            }) else {
                continue;
            };
            // Sized to what this session actually writes: a mic-only meeting
            // writes one track, "me and them" writes three.
            match audio::meeting_space_pressure(available, health.track_count) {
                audio::MeetingSpacePressure::Ok => {}
                audio::MeetingSpacePressure::Low => {
                    if !low_space_reported {
                        low_space_reported = true;
                        emit_meeting_capture_warning(
                            state.as_ref(),
                            &handle,
                            &recording_id,
                            &format!(
                                "This disk is nearly full ({} MB free). Plainsong will stop this meeting on its own before the disk runs out — free some space to keep recording.",
                                available / (1024 * 1024)
                            ),
                        );
                    }
                }
                audio::MeetingSpacePressure::Critical => {
                    emit_meeting_capture_warning(
                        state.as_ref(),
                        &handle,
                        &recording_id,
                        &format!(
                            "This disk is out of space ({} MB free), so Plainsong is stopping the meeting now to save the audio it already captured.",
                            available / (1024 * 1024)
                        ),
                    );
                    {
                        let mut db = state.db.lock().await;
                        let _ = db.log_audit_event(
                            "recording_stopped_low_disk_space",
                            Some(serde_json::json!({
                                "recording_id": &recording_id,
                                "available_bytes": available,
                            })),
                            "error",
                        );
                    }
                    // A deliberate stop lands the WAVs, hashes them and hands
                    // the meeting to transcription. Letting the writer hit
                    // ENOSPC instead loses everything after the last checkpoint.
                    if let Err(error) =
                        stop_recording_for_sidecar(&state, &handle, recording_id.clone()).await
                    {
                        tracing::error!(
                            "Failed to stop meeting {} after running out of disk space: {}",
                            recording_id,
                            error
                        );
                    }
                    return;
                }
            }
        }
    });
}

/// Padding shorter than this is the normal cost of starting and stopping two
/// devices that never open at exactly the same instant, not a source that went
/// away. Reporting it would put a caveat on every healthy mixed meeting.
const MEETING_SOURCE_SILENCE_REPORT_THRESHOLD_SECONDS: f64 = 1.0;

/// One sentence saying what this meeting's audio is actually missing, or `None`
/// when the capture was clean.
///
/// Persisted on the recording and emitted at stop. Both halves matter: a dead
/// input stream truncates the recording, and a mixed session that lost one
/// source keeps running with that source padded to silence — the file cannot
/// tell that apart from a quiet room, so the record has to.
fn describe_recording_capture_degradation(
    capture_failure: Option<&str>,
    degradation: Option<&audio::RecordingSourceDegradation>,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(reason) = capture_failure {
        parts.push(format!(
            "A capture stream stopped sending audio during this meeting, so the recording ends early. Audio captured before that point was saved. ({reason})"
        ));
    }
    if let Some(degradation) = degradation {
        for (label, silent_seconds) in [
            ("The microphone", degradation.mic_silent_seconds),
            ("System audio", degradation.system_silent_seconds),
        ] {
            if silent_seconds < MEETING_SOURCE_SILENCE_REPORT_THRESHOLD_SECONDS {
                continue;
            }
            parts.push(format!(
                "{label} delivered nothing for about {}s of this {}s meeting; that stretch is silence in the saved audio, not a quiet room.",
                silent_seconds.round() as i64,
                degradation.captured_seconds.round() as i64
            ));
        }
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Sidecar-compatible stop_recording. Triggers transcription in a background task.
async fn stop_recording_for_sidecar(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: String,
) -> Result<(), String> {
    let result = stop_recording_for_sidecar_inner(state, handle, recording_id.clone()).await;
    if let Err(message) = result.as_ref() {
        let owns_stopping_lifecycle = state
            .recording_overlay_state
            .lock()
            .map(|overlay| {
                overlay.recording_id.as_deref() == Some(recording_id.as_str())
                    && overlay.phase == "stopping"
            })
            .unwrap_or(false);
        if owns_stopping_lifecycle {
            {
                let mut db = state.db.lock().await;
                let _ = db.update_recording_status(&recording_id, "error");
            }
            handle.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id,
                    "status": "error",
                    "message": message,
                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            emit_meeting_lifecycle_phase(
                state.as_ref(),
                handle,
                "error",
                &recording_id,
                Some(message),
            );
        }
    }
    result
}

/// How long stopping a meeting will wait for the audio storage gate before it
/// ends capture anyway.
///
/// Long enough for a short encryption or deletion step already in flight to
/// finish, short enough that the user is never left recording into a
/// still-running retention sweep.
const MEETING_STOP_STORAGE_GATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Take the audio storage gate, or give up after `timeout`.
///
/// Separated from the stop path so the "how long do we wait" policy is testable
/// without an `AppState`; the caller decides what giving up means.
async fn acquire_storage_gate_for_stop(
    gate: &Mutex<()>,
    timeout: Duration,
) -> Option<tokio::sync::MutexGuard<'_, ()>> {
    tokio::time::timeout(timeout, gate.lock()).await.ok()
}

async fn stop_recording_for_sidecar_inner(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    recording_id: String,
) -> Result<(), String> {
    tracing::info!("stop_recording_for_sidecar called for {}", recording_id);
    let _capture_lease = {
        let mut active_capture = state.active_capture_lease.lock().await;
        match active_capture.as_ref() {
            Some((active_recording_id, _)) if active_recording_id == &recording_id => {}
            Some((active_recording_id, _)) => {
                return Err(format!(
                    "Cannot stop recording '{}'; '{}' is the active capture.",
                    recording_id, active_recording_id
                ));
            }
            None => {
                drop(active_capture);
                let stored_status = {
                    let db = state.db.lock().await;
                    db.get_recording(&recording_id)
                        .map_err(|error| error.to_string())?
                        .map(|recording| recording.status)
                };
                return match stored_status.as_deref() {
                    Some(status) if meeting_stop_is_already_terminal_or_processing(status) => {
                        Ok(())
                    }
                    Some(_) => Err(format!(
                        "Meeting '{}' is not an active capture and is not safely finalized.",
                        recording_id
                    )),
                    None => Err(format!("Meeting '{}' was not found.", recording_id)),
                };
            }
        }
        active_capture
            .take()
            .expect("active capture was checked before take")
            .1
    };
    emit_meeting_lifecycle_phase(
        state.as_ref(),
        handle,
        "stopping",
        &recording_id,
        Some("Stopping capture and saving audio"),
    );

    state.recording_stream_stop.store(true, Ordering::SeqCst);

    // Ending data acquisition must not wait behind a storage sweep. The gate
    // protects the recordings directory from concurrent deletion, backup and
    // encryption work; it protects nothing about the capture streams, which is
    // what keeps holding the microphone and filling the disk while the user is
    // waiting for their meeting to stop. The `StorageMaintenance` lease makes
    // this a rare path, and the timeout means "rare" never becomes "forever".
    let mut storage_guard =
        acquire_storage_gate_for_stop(&state.audio_storage_gate, MEETING_STOP_STORAGE_GATE_TIMEOUT)
            .await;
    if storage_guard.is_none() {
        tracing::warn!(
            "Recording storage was still busy after {:?}; ending capture for {} before taking the gate",
            MEETING_STOP_STORAGE_GATE_TIMEOUT,
            recording_id
        );
        emit_meeting_lifecycle_phase(
            state.as_ref(),
            handle,
            "stopping",
            &recording_id,
            Some("Recording storage is busy. Ending capture now and saving the audio as soon as it frees up."),
        );
    }

    let stop_result = {
        let mut audio = state.audio_capture.lock().await;
        audio.stop_recording(&recording_id)
    };

    // Capture has ended either way, so waiting here costs no more audio. Every
    // durable write below — the finalization-failure path included — happens
    // under the gate.
    if storage_guard.is_none() {
        storage_guard = Some(state.audio_storage_gate.lock().await);
    }
    let _storage_guard = storage_guard;

    let stop_result = match stop_result {
        Ok(result) => result,
        Err(error) => {
            let message = format!("Failed to finalize recording: {error}");
            persist_recording_finalization_failure(state.as_ref(), &recording_id, &message).await;
            return Err(message);
        }
    };

    // The input stream can die mid-meeting — an unplugged microphone, a
    // switched audio device, a sample-rate invalidation. CoreAudio reports it
    // to the error callback and then simply stops delivering samples, so the
    // recording still "succeeds" with a file that is shorter than the elapsed
    // session. Say so instead of presenting a silently truncated meeting as a
    // complete one.
    //
    // The per-source silence padding matters for the same reason and is the only
    // way to say it for a "me and them" meeting: a mixed session keeps running
    // when one source dies, and the padded silence in the file is
    // indistinguishable from a quiet room.
    let capture_degradation = describe_recording_capture_degradation(
        stop_result.capture_failure.as_deref(),
        stop_result.source_degradation.as_ref(),
    );
    if let Some(message) = capture_degradation.as_deref() {
        tracing::error!(
            "Recording {} captured degraded audio: {}",
            recording_id,
            message
        );
        handle.emit_event(
            "recording-status-changed",
            serde_json::json!({
                "recordingId": &recording_id,
                "status": "warning",
                "message": message,
                "updatedAt": chrono::Utc::now().to_rfc3339(),
            }),
        );
    }

    let audio_path = stop_result.audio_path.clone();
    let duration_seconds = stop_result
        .validated_assets
        .iter()
        .find(|(role, _)| *role == recording_audio::RecordingAudioRole::Primary)
        .map(|(_, metadata)| metadata.duration_seconds)
        .ok_or_else(|| "Finalized recording has no primary audio metadata".to_string())?;
    {
        let mut db = state.db.lock().await;
        db.finalize_recording_audio(
            &recording_id,
            &stop_result.validated_assets,
            duration_seconds,
            "processing",
            capture_degradation.as_deref(),
        )
        .map_err(|error| error.to_string())?;
        // The audio skips every pause, so this is the only record of where
        // the gaps are; a failure to write it costs the timeline markers and
        // nothing else, so it does not fail the stop.
        if let Err(error) = db.set_recording_pause_spans(&recording_id, &stop_result.pause_spans) {
            tracing::warn!(
                "Failed to persist pause spans for {}: {}",
                recording_id,
                error
            );
        }
        let details = serde_json::json!({
            "recording_id": &recording_id, "audio_path": &audio_path,
            "duration_seconds": duration_seconds,
            "dropped_stream_chunks": stop_result.dropped_stream_chunks,
            "capture_degraded_summary": &capture_degradation,
            "pause_count": stop_result.pause_spans.len(),
            "paused_ms": recording_pause::paused_total_ms(
                &stop_result.pause_spans,
                chrono::Utc::now().timestamp_millis(),
            ),
        });
        if let Err(error) = db.log_audit_event("recording_stopped", Some(details), "info") {
            tracing::warn!("Failed to log audit event: {}", error);
        }
    }

    if let Err(error) =
        encrypt_finalized_recording_audio(state.as_ref(), Some(handle), &recording_id).await
    {
        return Err(format!(
            "Recording was finalized, but vault encryption must be retried before transcription: {error}"
        ));
    }

    emit_meeting_lifecycle_phase(
        state.as_ref(),
        handle,
        "processing",
        &recording_id,
        Some("Processing transcript"),
    );
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": &recording_id, "status": "processing",
            "message": "Processing transcript", "progress": 0.0,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );

    // Hide the recording overlay. Transcription will happen in the background.
    handle.window_command("hide-recording-overlay", &serde_json::Value::Null);

    let pipeline_state = Arc::clone(state);
    let pipeline_handle = handle.clone();
    let pipeline_recording_id = recording_id.clone();
    let postprocessing_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::PostProcess)?;
    let audio_postprocessing_guard = MeetingAudioPostprocessingGuard::coordinated(
        Arc::clone(&state.active_meeting_audio_postprocessing),
        &recording_id,
        postprocessing_lease,
    );
    tokio::spawn(async move {
        run_meeting_transcription_pipeline(
            Arc::clone(&pipeline_state),
            pipeline_handle,
            pipeline_recording_id,
            audio_postprocessing_guard,
        )
        .await;
    });

    Ok(())
}

/// Everything an "Import audio…" produces before the database sees it: the
/// planned recording id and audio path, the title taken from the file, and the
/// converted WAV's validated metadata.
#[derive(Debug)]
struct PreparedAudioImport {
    plan: recording_audio::RecordingCapturePlan,
    title: String,
    source_file_name: String,
    validated: recording_audio::ValidatedRecordingAudio,
}

/// Said when the import path is reached on a platform that has no `afconvert`.
const IMPORT_UNSUPPORTED_PLATFORM: &str =
    "Importing an audio file is not supported on this platform yet. It uses macOS' own audio decoder.";

/// Ask macOS how long a file is without decoding it.
///
/// Plain `afinfo`, not `afinfo --brief`: the brief report has no
/// `estimated duration:` line at all, so the previous invocation always parsed
/// to `None`, the caller treated that as "unknown, carry on", and the four-hour
/// guard never ran -- a nine-hour file was decoded in full before anything
/// refused it. Both report shapes are parsed anyway, so a future macOS that
/// changes which one carries the number still gets a length.
///
/// A length nobody can state is a refusal, not a pass. Refusing costs an
/// unreadable file an error it was going to get from `afconvert` a moment
/// later; passing costs an unbounded decode.
fn probe_audio_duration_seconds(path: &Path) -> Result<f64, String> {
    if !cfg!(target_os = "macos") {
        return Err(IMPORT_UNSUPPORTED_PLATFORM.to_string());
    }
    let output = std::process::Command::new("/usr/bin/afinfo")
        .arg(path)
        .output()
        .map_err(|error| format!("Plainsong could not run the macOS audio inspector: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    audio_import::parse_afinfo_duration_seconds(&stdout)
        .or_else(|| audio_import::parse_afinfo_duration_seconds(&stderr))
        .ok_or_else(|| audio_import::unreadable_duration_message(&stderr))
}

/// How often the conversion is checked for having finished. Short enough that
/// a two-second file still returns promptly, long enough that an eight-hour
/// budget is not a spin loop.
const AFCONVERT_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// Run macOS' `afconvert` to decode `source` into `destination`, giving up
/// after `timeout`.
///
/// The timeout is the point of this function. `afconvert` is spawned rather
/// than run to completion with `Command::output()` because the caller holds
/// the audio storage gate and the PostProcess lease for the whole call: a
/// source on a network volume that stops answering used to block here forever,
/// and retention, vault migration, backup and every other meeting's
/// post-processing waited behind it until the sidecar was restarted. The IPC
/// budget cancelling the caller did not help -- nothing killed the child.
fn run_afconvert(
    source: &Path,
    destination: &Path,
    timeout: std::time::Duration,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(IMPORT_UNSUPPORTED_PLATFORM.to_string());
    }
    let mut child = std::process::Command::new("/usr/bin/afconvert")
        .args(audio_import::afconvert_args(source, destination))
        // stdout is discarded rather than piped: nothing reads it until the
        // child exits, and an unread pipe that fills would hang the very wait
        // this function exists to bound. afconvert says nothing there anyway --
        // verified that its refusals ("Error: Couldn't open input file") go to
        // stderr, which stays piped because that sentence is what the reader
        // needs.
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Plainsong could not run the macOS audio converter: {error}"))?;

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Plainsong lost track of the macOS audio converter: {error}"
                ));
            }
        }
        if std::time::Instant::now() >= deadline {
            // Kill first, then reap, so the caller's locks are released with no
            // orphan still writing into the recordings folder behind them.
            let _ = child.kill();
            let _ = child.wait();
            return Err(audio_import::conversion_timeout_message(timeout));
        }
        std::thread::sleep(AFCONVERT_POLL_INTERVAL);
    };

    let stderr = child
        .stderr
        .take()
        .map(|mut pipe| {
            use std::io::Read;
            let mut buffer = String::new();
            let _ = pipe.read_to_string(&mut buffer);
            buffer
        })
        .unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    // afconvert reports a codec it cannot read on stderr; the reader needs
    // that sentence, not just an exit code.
    let detail = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("the converter gave no reason")
        .to_string();
    Err(format!("macOS could not decode that audio file: {detail}"))
}

/// Validate a chosen audio file and decode it into the recordings store.
///
/// Deliberately free of `AppState` and of the database so the whole
/// file-to-recording step can be tested against a generated WAV in a temp
/// directory without a recognizer, a model, or a running sidecar.
fn prepare_audio_import(
    source_path: &Path,
    recordings_dir: &Path,
) -> Result<PreparedAudioImport, String> {
    audio_import::validate_import_extension(source_path)?;
    let metadata = std::fs::symlink_metadata(source_path).map_err(|error| {
        format!(
            "Plainsong could not read '{}': {}",
            source_path.display(),
            error
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err("Choose an audio file, not a folder or a link.".to_string());
    }
    audio_import::validate_import_size(metadata.len())?;
    // Before anything is decoded: a length macOS will not state is a refusal,
    // and the length it does state is what the 4-hour guard, the conversion
    // timeout and the free-space estimate are all derived from.
    let probed_seconds = probe_audio_duration_seconds(source_path)?;
    audio_import::validate_import_duration(probed_seconds)?;

    std::fs::create_dir_all(recordings_dir).map_err(|error| {
        format!(
            "Failed to prepare the recordings folder '{}': {}",
            recordings_dir.display(),
            error
        )
    })?;
    // Refuse a conversion the volume cannot hold rather than filling the disk
    // and failing halfway, which would also take down any meeting recording
    // into the same folder.
    if let Some(needed) = audio_import::import_space_shortfall(
        probed_seconds,
        crate::download::available_space_for_path(recordings_dir).ok(),
    ) {
        return Err(audio_import::insufficient_space_message(needed));
    }
    // One mic-shaped track: an imported file is a single source, so the plan
    // has a primary path and no per-source companions.
    let plan = recording_audio::RecordingCapturePlan::new(recordings_dir, true, false)
        .map_err(|error| error.to_string())?;
    // Armed until the converted WAV has been read back successfully, so a
    // refused, timed-out or corrupt import leaves nothing behind in the store.
    let converted = recording_audio::DurableTempFile::new(plan.primary_path.clone());
    run_afconvert(
        source_path,
        &plan.primary_path,
        audio_import::import_conversion_timeout(probed_seconds),
    )?;
    let validated = match recording_audio::validate_plaintext_wav(&plan.primary_path) {
        recording_audio::RecordingAudioValidation::Ready(metadata) => metadata,
        recording_audio::RecordingAudioValidation::Missing(reason)
        | recording_audio::RecordingAudioValidation::Failed(reason) => {
            return Err(format!(
                "Plainsong could not read the converted audio: {reason}"
            ));
        }
    };
    // The authoritative duration check: afinfo above is an estimate, this is
    // the file the pipeline will actually transcribe.
    audio_import::validate_import_duration(validated.duration_seconds as f64)?;
    let _ = converted.disarm();

    Ok(PreparedAudioImport {
        title: audio_import::import_title_from_file_name(source_path),
        source_file_name: source_path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        plan,
        validated,
    })
}

/// Turn a prepared import into the meeting row the pipeline will pick up.
///
/// `consent_prompt_shown` stays false: nobody was in the room when Plainsong
/// got this audio, so claiming a consent prompt was shown would be a lie. The
/// capture mode is `imported`, which is what the Meetings view reads to show
/// "Imported file" instead of Me + Them.
fn imported_recording_row(
    prepared: &PreparedAudioImport,
    project_id: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> models::Recording {
    models::Recording {
        id: prepared.plan.recording_id.clone(),
        title: prepared.title.clone(),
        project_id: project_id.to_string(),
        duration: prepared.validated.duration_seconds,
        created_at: now,
        updated_at: now,
        source_type: "meeting".to_string(),
        audio_path: prepared.plan.primary_path.to_string_lossy().to_string(),
        status: "processing".to_string(),
        summary: None,
        action_items: None,
        summary_provenance: None,
        action_items_provenance: None,
        meeting_notes: None,
        meeting_template_id: None,
        meeting_capture_mode: Some(IMPORTED_MEETING_CAPTURE_MODE.to_string()),
        imported_source_name: Some(prepared.source_file_name.clone())
            .filter(|value| !value.trim().is_empty()),
        notes_updated_at: None,
        consent_prompt_shown: false,
        consent_notice_mode: None,
        consent_notice_surface: None,
        consent_notice_message: None,
        consent_notice_updated_at: None,
        analysis_failure: None,
        pause_spans: Vec::new(),
        video_service: None,
        attendees: Vec::new(),
    }
}

/// The capture mode written for a meeting that came from a file rather than a
/// microphone. Mirrored by `MEETING_CAPTURE_MODE_IMPORTED` in
/// `src/types/index.ts`.
const IMPORTED_MEETING_CAPTURE_MODE: &str = "imported";

/// Persist a prepared import: the meeting row, its owned audio asset, and the
/// audit entry that records where the audio came from.
fn persist_audio_import(
    db: &mut db::Database,
    prepared: &PreparedAudioImport,
    recording: &models::Recording,
) -> Result<(), String> {
    db.create_recording_with_audio_plan(recording, &prepared.plan)
        .map_err(|error| error.to_string())?;
    db.finalize_recording_audio(
        &recording.id,
        &[(
            recording_audio::RecordingAudioRole::Primary,
            prepared.validated.clone(),
        )],
        prepared.validated.duration_seconds,
        "processing",
        None,
    )
    .map_err(|error| error.to_string())?;
    // The original file's name is recorded; its directory is not, so the audit
    // log does not become a map of the reader's disk.
    if let Err(error) = db.log_audit_event(
        "meeting_audio_imported",
        Some(serde_json::json!({
            "recording_id": &recording.id,
            "source_file_name": &prepared.source_file_name,
            "duration_seconds": prepared.validated.duration_seconds,
            "converted_bytes": prepared.validated.plaintext_bytes,
        })),
        "info",
    ) {
        tracing::warn!("Failed to log audio import audit event: {}", error);
    }
    Ok(())
}

/// `import_audio_file`: decode a file the user picked, save it as a meeting,
/// and hand it to the same post-capture pipeline a stopped meeting uses.
///
/// The original file is only ever read.
async fn import_audio_file_impl(
    state: &Arc<AppState>,
    handle: &crate::sidecar_handle::SidecarHandle,
    source_path: PathBuf,
) -> Result<serde_json::Value, String> {
    // Same lease the stop path and `retranscribe_recording` take, so an import
    // cannot start on top of a backup, a vault migration, or another meeting's
    // post-processing.
    let postprocessing_lease = state
        .operation_coordinator
        .try_acquire(operation_coordinator::OperationKind::PostProcess)?;

    let project_id = {
        let settings = state.settings_manager.lock().await;
        settings
            .settings()
            .transcription
            .dictation_project_id
            .clone()
    };
    let recordings_dir = nautilus_data_root()?.join("recordings");

    let prepared = {
        // Decoding writes into the recordings store, so it holds the same gate
        // a retention sweep and the vault migration take.
        let _storage_guard = state.audio_storage_gate.lock().await;
        let source_for_task = source_path.clone();
        let dir_for_task = recordings_dir.clone();
        // afconvert on a long file takes minutes; it must not sit on the async
        // runtime while it runs.
        tokio::task::spawn_blocking(move || prepare_audio_import(&source_for_task, &dir_for_task))
            .await
            .map_err(|error| format!("The audio import task failed: {error}"))??
    };

    let recording = imported_recording_row(&prepared, &project_id, chrono::Utc::now());
    {
        let mut db = state.db.lock().await;
        if let Err(error) = persist_audio_import(&mut db, &prepared, &recording) {
            drop(db);
            let _ = std::fs::remove_file(&prepared.plan.primary_path);
            return Err(format!(
                "Plainsong could not save the imported meeting: {error}"
            ));
        }
    }

    let recording_id = recording.id.clone();

    // Same order the stop path uses: the audio is encrypted into the vault
    // before the pipeline is allowed to read it. An imported file lands in the
    // recordings folder as the same kind of owned asset a meeting's audio does,
    // so skipping this left plaintext audio under a vault the UI says is on.
    if let Err(error) =
        encrypt_finalized_recording_audio(state.as_ref(), Some(handle), &recording_id).await
    {
        let mut db = state.db.lock().await;
        let _ = db.update_recording_status(&recording_id, "error");
        drop(db);
        let message = format!(
            "The audio was imported, but vault encryption must be retried before it can be transcribed: {error}"
        );
        emit_meeting_lifecycle_phase(
            state.as_ref(),
            handle,
            "error",
            &recording_id,
            Some(&message),
        );
        return Err(message);
    }

    // The same pair the stop path emits, in the same order. The import
    // previously emitted only `recording-status-changed`, so the renderer's
    // meeting state machine never left `idle` for an import: no processing
    // phase was ever shown, and the pipeline's own terminal `ready` or `error`
    // phase arrived for a meeting the machine had never heard of.
    emit_meeting_lifecycle_phase(
        state.as_ref(),
        handle,
        "processing",
        &recording_id,
        Some("Processing transcript"),
    );
    handle.emit_event(
        "recording-status-changed",
        serde_json::json!({
            "recordingId": &recording_id,
            "status": "processing",
            "message": "Processing transcript",
            "progress": 0.0,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );

    let audio_postprocessing_guard = MeetingAudioPostprocessingGuard::coordinated(
        Arc::clone(&state.active_meeting_audio_postprocessing),
        &recording_id,
        postprocessing_lease,
    );
    tokio::spawn(run_meeting_transcription_pipeline(
        Arc::clone(state),
        handle.clone(),
        recording_id.clone(),
        audio_postprocessing_guard,
    ));

    Ok(serde_json::json!({
        "recordingId": recording_id,
        "title": recording.title,
        "sourceFileName": prepared.source_file_name,
        "durationSeconds": prepared.validated.duration_seconds,
    }))
}

/// The import path from a file on disk to a saved meeting row, with the
/// recognizer deliberately left out: `prepare_audio_import` and
/// `persist_audio_import` are the seam, and everything after them is the same
/// pipeline a stopped meeting already runs.
#[cfg(test)]
#[cfg(target_os = "macos")]
mod audio_import_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A short stereo 44.1 kHz WAV, i.e. deliberately not the shape the
    /// meeting pipeline wants, so the conversion has something to do.
    fn write_stereo_fixture(path: &Path, seconds: u32) {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).expect("create fixture wav");
        for index in 0..(44_100 * seconds) {
            let value = ((index as f32 * 0.05).sin() * 8_000.0) as i16;
            writer.write_sample(value).expect("left");
            writer.write_sample(-value).expect("right");
        }
        writer.finalize().expect("finalize fixture wav");
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nautilus-import-{label}-{suffix}"));
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    #[test]
    fn importing_a_wav_converts_it_and_saves_one_meeting_row() {
        let root = scratch_dir("ok");
        let source = root.join("Q3 planning call.wav");
        write_stereo_fixture(&source, 2);
        let recordings_dir = root.join("recordings");

        let prepared =
            prepare_audio_import(&source, &recordings_dir).expect("a plain WAV must import");

        // The original is only ever read.
        assert!(source.is_file(), "the file the user picked must survive");
        // The converted copy lives in the recordings store, at 16 kHz mono.
        assert!(prepared.plan.primary_path.starts_with(&recordings_dir));
        let converted = hound::WavReader::open(&prepared.plan.primary_path).expect("converted wav");
        assert_eq!(converted.spec().channels, 1);
        assert_eq!(
            converted.spec().sample_rate,
            audio_import::IMPORT_SAMPLE_RATE_HZ
        );
        assert_eq!(prepared.validated.duration_seconds, 2);
        assert_eq!(prepared.title, "Q3 planning call");
        assert_eq!(prepared.source_file_name, "Q3 planning call.wav");

        let mut db = db::Database::new_in_memory_for_test().expect("in-memory db");
        let recording = imported_recording_row(&prepared, "inbox", chrono::Utc::now());
        persist_audio_import(&mut db, &prepared, &recording).expect("persist the imported meeting");

        let stored = db
            .get_recording(&recording.id)
            .expect("read back")
            .expect("the import must produce a recording row");
        assert_eq!(stored.source_type, "meeting");
        assert_eq!(stored.status, "processing");
        assert_eq!(stored.meeting_capture_mode.as_deref(), Some("imported"));
        assert_eq!(
            stored.imported_source_name.as_deref(),
            Some("Q3 planning call.wav")
        );
        assert_eq!(stored.title, "Q3 planning call");
        assert_eq!(stored.duration, 2);
        // Nobody was in the room, so no consent prompt is claimed.
        assert!(!stored.consent_prompt_shown);
        // The audio the pipeline will read is registered as owned, not orphaned.
        let bundle = db
            .load_recording_audio_bundle(&recording.id)
            .expect("audio bundle");
        assert_eq!(
            bundle.primary.as_ref().map(|asset| asset.path.clone()),
            Some(prepared.plan.primary_path.clone())
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_refused_file_leaves_nothing_in_the_recordings_store() {
        let root = scratch_dir("refused");
        let recordings_dir = root.join("recordings");

        // Wrong container: refused before anything is written.
        let text = root.join("notes.pdf");
        std::fs::write(&text, b"not audio").expect("write");
        let refusal = prepare_audio_import(&text, &recordings_dir).unwrap_err();
        assert!(refusal.contains(".pdf"), "{refusal}");
        assert!(
            !recordings_dir.exists(),
            "a refused extension writes nothing"
        );

        // Right container, unreadable contents: afinfo cannot state a length,
        // so the file is refused before afconvert is spawned at all.
        let fake = root.join("broken.mp3");
        std::fs::write(&fake, b"\x00\x01\x02 not an mp3").expect("write");
        let decode_failure = prepare_audio_import(&fake, &recordings_dir).unwrap_err();
        assert!(
            decode_failure.contains("could not determine the length"),
            "{decode_failure}"
        );
        let leftovers: Vec<_> = std::fs::read_dir(&recordings_dir)
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "a refused conversion must leave no file behind: {leftovers:?}"
        );

        // A directory is not a file, however it is spelled.
        let dir = root.join("album.wav");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let not_a_file = prepare_audio_import(&dir, &recordings_dir).unwrap_err();
        assert!(not_a_file.contains("not a folder"), "{not_a_file}");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The import wrote its converted WAV into the recordings store and started
    /// the pipeline without ever encrypting it, so with the vault on an
    /// imported meeting was plaintext audio sitting under a vault the UI says
    /// is on. `import_audio_file_impl` now runs the stop path's encryption step
    /// before the pipeline; this is the storage half of that, showing the asset
    /// the import registers is one the vault operation picks up.
    #[test]
    fn an_imported_meetings_audio_is_an_asset_the_vault_operation_can_encrypt() {
        let root = scratch_dir("vault");
        let source = root.join("board call.wav");
        write_stereo_fixture(&source, 1);
        let recordings_dir = root.join("recordings");

        let prepared = prepare_audio_import(&source, &recordings_dir).expect("import");
        let mut db = db::Database::new_in_memory_for_test().expect("in-memory db");
        let recording = imported_recording_row(&prepared, "inbox", chrono::Utc::now());
        persist_audio_import(&mut db, &prepared, &recording).expect("persist");

        // As persisted it is plaintext, like a meeting's audio at finalize.
        assert_eq!(db.count_encrypted_recordings().expect("counts"), (0, 1));

        let operation = db
            .begin_recording_audio_encryption(&recording.id)
            .expect("begin encryption")
            .expect("an imported meeting must open an encryption operation");
        assert_eq!(operation.items.len(), 1);
        assert_eq!(operation.items[0].source_path, prepared.plan.primary_path);

        db.switch_recording_audio_encryption(&operation)
            .expect("switch");
        assert_eq!(db.count_encrypted_recordings().expect("counts"), (1, 1));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The probe is what the four-hour guard depends on, so it has to state a
    /// real length for a real file rather than shrugging.
    #[test]
    fn the_duration_probe_reads_a_real_file_and_refuses_one_it_cannot_read() {
        let root = scratch_dir("probe");
        let source = root.join("two seconds.wav");
        write_stereo_fixture(&source, 2);

        let seconds = probe_audio_duration_seconds(&source)
            .expect("afinfo must state the length of a WAV it just wrote");
        assert!(
            (seconds - 2.0).abs() < 0.05,
            "probed {seconds} s for a 2 s file"
        );
        // The length is well under the guard, and the guard agrees.
        assert!(audio_import::validate_import_duration(seconds).is_ok());

        // A file CoreAudio cannot open has no length, and that is a refusal.
        let junk = root.join("not audio.wav");
        std::fs::write(&junk, b"RIFFnope").expect("write");
        let refusal = probe_audio_duration_seconds(&junk).unwrap_err();
        assert!(
            refusal.contains("could not determine the length"),
            "{refusal}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A conversion that will not finish must not hold the caller's locks
    /// forever, and must not leave the child running behind the error.
    #[test]
    fn a_conversion_that_does_not_finish_is_killed_and_reported() {
        let root = scratch_dir("timeout");
        let source = root.join("silence.wav");
        write_stereo_fixture(&source, 1);
        let destination = root.join("out.wav");

        let started = std::time::Instant::now();
        let failure =
            run_afconvert(&source, &destination, std::time::Duration::from_millis(0)).unwrap_err();
        // A zero budget is past its deadline on the first poll, so this is the
        // timeout path even though the file itself is trivial.
        assert!(failure.contains("Plainsong stopped it"), "{failure}");
        assert!(failure.contains("network volume"), "{failure}");
        // The wait is bounded by the budget, not by the converter.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the timeout must return promptly, took {:?}",
            started.elapsed()
        );

        // The same call with a real budget succeeds, so the timeout is the
        // only thing the failure above proves.
        assert!(run_afconvert(
            &source,
            &destination,
            audio_import::import_conversion_timeout(1.0)
        )
        .is_ok());
        assert!(destination.is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every extension the picker offers must be one macOS can actually open.
    #[test]
    fn every_advertised_extension_is_one_afconvert_can_open() {
        let root = scratch_dir("formats");
        let source = root.join("source.wav");
        write_stereo_fixture(&source, 1);

        // .wav, .m4a, .mp4 and .aac are all CoreAudio-native; converting into
        // each one and probing it back proves the pipeline's own claim.
        for (extension, file_format) in [("m4a", "m4af"), ("mp4", "mp4f"), ("caf", "caff")] {
            let converted = root.join(format!("probe.{extension}"));
            let status = std::process::Command::new("/usr/bin/afconvert")
                .args(["-f", file_format, "-d", "aac"])
                .arg(&source)
                .arg(&converted)
                .status()
                .expect("run afconvert");
            if !status.success() {
                continue;
            }
            let seconds = probe_audio_duration_seconds(&converted)
                .unwrap_or_else(|error| panic!("afinfo could not read .{extension}: {error}"));
            assert!(seconds > 0.5, ".{extension} probed as {seconds} s");
        }

        // And the one that is gone: a real WebM is refused by name before
        // anything runs, which is the whole reason it was dropped.
        let webm = root.join("call.webm");
        std::fs::write(&webm, b"\x1a\x45\xdf\xa3 matroska").expect("write");
        let refusal = prepare_audio_import(&webm, &root.join("recordings")).unwrap_err();
        assert!(refusal.contains(".webm"), "{refusal}");

        let _ = std::fs::remove_dir_all(&root);
    }
}

fn emit_completed_after_persistence(
    persistence_result: Result<(), String>,
    app: &impl crate::sidecar_handle::AppEmitter,
    payload: serde_json::Value,
) -> Result<(), String> {
    persistence_result?;
    app.emit_event("recording-status-changed", payload);
    Ok(())
}

/// Full post-capture meeting transcription pipeline: chunked ASR (source-aware
/// when the per-source WAVs exist), diarization, persistence, storage policy,
/// auto-naming, auto-analysis, and retention. The chunked transcription itself
/// emits progressive transcript events, so starting a second preview decoder
/// here would duplicate local model work and delay the durable transcript.
/// Shared by the stop-recording flow and the `retranscribe_recording`
/// command.
async fn run_meeting_transcription_pipeline(
    state_clone: Arc<AppState>,
    handle_clone: crate::sidecar_handle::SidecarHandle,
    recording_id_clone: String,
    _audio_postprocessing_guard: MeetingAudioPostprocessingGuard,
) {
    let resolved_audio =
        match resolve_recording_audio_bundle_for_runtime(state_clone.as_ref(), &recording_id_clone)
            .await
        {
            Ok(bundle) => bundle,
            Err(error) => {
                tracing::error!(
                    "Failed to resolve recording audio bundle for {}: {}",
                    recording_id_clone,
                    error
                );
                let mut db = state_clone.db.lock().await;
                if let Err(status_error) = db.update_recording_status(&recording_id_clone, "error")
                {
                    tracing::error!(
                        "Failed to persist audio-resolution error status for {}: {}",
                        recording_id_clone,
                        status_error
                    );
                }
                drop(db);
                handle_clone.emit_event(
                    "recording-status-changed",
                    serde_json::json!({
                        "recordingId": &recording_id_clone,
                        "status": "error",
                        "message": &error,
                        "updatedAt": chrono::Utc::now().to_rfc3339(),
                    }),
                );
                emit_meeting_lifecycle_phase(
                    state_clone.as_ref(),
                    &handle_clone,
                    "error",
                    &recording_id_clone,
                    Some(&error),
                );
                return;
            }
        };
    let path = resolved_audio.primary.clone();

    let meeting_selection = {
        let settings = state_clone.settings_manager.lock().await.settings().clone();
        resolve_ready_meeting_selection(
            state_clone.as_ref(),
            &settings.transcription,
            settings.privacy.remote_processing_enabled,
        )
        .await
    };
    let (meeting_provider, meeting_model_id, meeting_route_warning) = match meeting_selection {
        Ok(selection) => selection,
        Err(error) => {
            tracing::error!(
                "Failed to resolve ready meeting route for {}: {}",
                recording_id_clone,
                error
            );
            {
                let mut db = state_clone.db.lock().await;
                if let Err(status_error) = db.update_recording_status(&recording_id_clone, "error")
                {
                    tracing::error!(
                        "Failed to persist route-resolution error status for {}: {}",
                        recording_id_clone,
                        status_error
                    );
                }
                if let Err(audit_error) = db.log_audit_event(
                    "transcription_failed",
                    Some(serde_json::json!({"recording_id": &recording_id_clone, "error": &error})),
                    "error",
                ) {
                    tracing::warn!(
                        "Failed to log route-resolution error for {}: {}",
                        recording_id_clone,
                        audit_error
                    );
                }
            }
            handle_clone.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id_clone, "status": "error",
                    "message": &error, "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            emit_meeting_lifecycle_phase(
                state_clone.as_ref(),
                &handle_clone,
                "error",
                &recording_id_clone,
                Some(&error),
            );
            return;
        }
    };
    if let Some(warning) = meeting_route_warning {
        tracing::warn!("{}", warning);
    }

    // Both switches, read together: "keep the speakers a cloud provider sends
    // back" only means anything while speaker separation is on at all, and the
    // whole-file request exists solely to make those labels usable.
    let (enable_diarization, prefer_provider_diarization) = {
        let sm = state_clone.settings_manager.lock().await;
        let settings = sm.settings();
        (
            settings.transcription.enable_diarization,
            settings.meetings.prefer_provider_diarization,
        )
    };

    match transcribe_meeting_recording(
        &handle_clone,
        Arc::clone(&state_clone.asr_manager),
        &recording_id_clone,
        &path,
        resolved_audio.mic.as_deref(),
        resolved_audio.system.as_deref(),
        meeting_provider,
        meeting_model_id.clone(),
        enable_diarization,
        prefer_provider_diarization,
    )
    .await
    {
        Ok(output) => {
            // Captured before `output.transcript` is moved out below: this is
            // the only place a chunk/source transcription failure that was
            // survived (rather than aborting the whole meeting) is visible.
            // Without threading it through here it would reach neither the
            // DB nor an emitted event, and the meeting would be marked
            // "completed" with no signal that it may be incomplete.
            let degraded_reason = output
                .fallback_reason
                .as_deref()
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .map(str::to_string);
            let provider_speaker_turns = output.speaker_turns;
            let transcribed_by_provider = output.actual_provider;
            let mut transcript = output.transcript;
            // Load the learned dictionary before enrichment: the correction has
            // to be in the transcript that gets persisted, because summary,
            // action items, and the auto-title are all derived from it
            // afterwards. A dictionary read failure is not worth failing a
            // finished meeting over -- the transcript is still correct, just not
            // term-corrected -- so it degrades to no substitutions.
            let meeting_dictionary_entries = {
                let db = state_clone.db.lock().await;
                match db.list_dictation_dictionary_entries() {
                    Ok(entries) => entries,
                    Err(error) => {
                        tracing::warn!(
                            "Could not read the dictation dictionary for meeting {}; \
                             continuing without term corrections: {}",
                            recording_id_clone,
                            error
                        );
                        Vec::new()
                    }
                }
            };
            enrich_meeting_transcript(&mut transcript, &meeting_dictionary_entries);

            let persistence_result = {
                let mut db = state_clone.db.lock().await;
                match db.save_transcript(&transcript) {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        if let Err(status_error) =
                            db.update_recording_status(&recording_id_clone, "error")
                        {
                            tracing::error!(
                                "Failed to mark meeting {} errored after transcript persistence failed: {}",
                                recording_id_clone,
                                status_error
                            );
                        }
                        if let Err(audit_error) = db.log_audit_event(
                            "transcription_persistence_failed",
                            Some(serde_json::json!({
                                "recording_id": &recording_id_clone,
                                "error": error.to_string(),
                            })),
                            "error",
                        ) {
                            tracing::warn!(
                                "Failed to log transcript persistence failure for {}: {}",
                                recording_id_clone,
                                audit_error
                            );
                        }
                        Err(error.to_string())
                    }
                }
            };

            let transcript_persisted = persistence_result.is_ok();
            let completion_result = match persistence_result {
                Ok(()) => {
                    // Status and completeness are written together on purpose.
                    // Any window where this reads as a plain "completed" is a
                    // window in which the transcript-only storage sweep can
                    // delete the audio of a meeting the code already knows was
                    // only partially transcribed.
                    let mut db = state_clone.db.lock().await;
                    match db.complete_recording_with_transcript_state(
                        &recording_id_clone,
                        "completed",
                        degraded_reason.is_none(),
                        degraded_reason.as_deref(),
                    ) {
                        Ok(()) => Ok(()),
                        Err(error) => {
                            let _ = db.update_recording_status(&recording_id_clone, "error");
                            Err(error.to_string())
                        }
                    }
                }
                Err(error) => Err(error),
            };
            let completed_at = chrono::Utc::now().to_rfc3339();
            let completion_result = emit_completed_after_persistence(
                completion_result,
                &handle_clone,
                serde_json::json!({
                    "recordingId": &recording_id_clone,
                    "status": "completed",
                    "progress": 1.0,
                    "updatedAt": &completed_at,
                    "transcriptFirstAvailableAt": &completed_at,
                    "message": &degraded_reason,
                    "degraded": degraded_reason.is_some(),
                }),
            );
            if let Err(error) = completion_result.as_ref() {
                tracing::error!(
                    "Failed to finalize completed transcript for {}: {}",
                    recording_id_clone,
                    error
                );
                handle_clone.emit_event(
                    "recording-status-changed",
                    serde_json::json!({
                        "recordingId": &recording_id_clone,
                        "status": "error",
                        "message": format!("Failed to finalize transcript: {}", error),
                        "updatedAt": chrono::Utc::now().to_rfc3339(),
                    }),
                );
                let message = format!("Failed to finalize transcript: {error}");
                emit_meeting_lifecycle_phase(
                    state_clone.as_ref(),
                    &handle_clone,
                    "error",
                    &recording_id_clone,
                    Some(&message),
                );
                return;
            }

            // Completion is durable and visible before optional diarization begins.
            // The post-processing guard keeps retention and reset from removing
            // this recording while best-effort enrichment is still reading it.
            let mut diarization_updated = false;
            let mut diarization_fallback_notice: Option<String> = None;
            if transcript_persisted {
                let (enable_diarization, diarization_model_id) = {
                    let sm = state_clone.settings_manager.lock().await;
                    let transcription = &sm.settings().transcription;
                    (
                        transcription.enable_diarization,
                        transcription
                            .diarization_model_id
                            .clone()
                            .unwrap_or_else(|| "ecapa_tdnn_speaker".to_string()),
                    )
                };
                // The automatic pass runs the model the user picked, not
                // always the default one, and readiness is asked per model
                // (the experimental speakrs backend needs a bundle, not one
                // .onnx). `resolve_model_for_run` answers both questions at
                // once: whether anything local can run at all, and which model
                // it will be.
                let resolved_local_model =
                    diarization::resolve_model_for_run(&diarization_model_id);
                let diarizer = resolve_meeting_diarizer(
                    enable_diarization,
                    prefer_provider_diarization,
                    transcript_has_source_aware_speakers(&transcript.segments),
                    transcribed_by_provider,
                    provider_speaker_turns.len(),
                    resolved_local_model.is_some(),
                );
                let local_diarization_model_id = resolved_local_model
                    .as_ref()
                    .map(|resolved| resolved.model_id.clone())
                    .unwrap_or_else(|| diarization_model_id.clone());
                let diarizer_record = diarizer.record_value(&local_diarization_model_id);

                // Both branches produce a `DiarizationResult` and hand it to
                // the same merge, so the transcript contract, the speaker ids
                // and the rename/alias flow are identical whichever diarizer
                // ran. The only difference the reader sees is the line naming
                // it.
                let diarization_result = match &diarizer {
                    MeetingDiarizer::None => None,
                    MeetingDiarizer::Provider(_) => {
                        let duration = transcript
                            .segments
                            .last()
                            .map(|segment| segment.end_time)
                            .unwrap_or(0.0);
                        Some(Ok(diarization_result_from_provider_turns(
                            &provider_speaker_turns,
                            duration,
                        )))
                    }
                    MeetingDiarizer::Local => Some(
                        diarization::run_diarization_with_model(&path, &local_diarization_model_id)
                            .await,
                    ),
                };

                match diarization_result {
                    None => {}
                    Some(Ok(result)) => {
                        let engine = diarization::DiarizationEngine::new();
                        let mut enriched_segments = transcript.segments.clone();
                        engine.merge_with_transcript(&result, &mut enriched_segments);
                        let update_result = {
                            let mut db = state_clone.db.lock().await;
                            // The audit entry goes in with the enrichment, not
                            // after it: the `diarizer` column and the entry
                            // record the same fact, and writing them under two
                            // separate lock acquisitions left a window where
                            // the column had changed and nothing said why.
                            db.apply_diarization_enrichment(
                                &recording_id_clone,
                                0,
                                &enriched_segments,
                                &[],
                                diarizer_record.as_deref(),
                                Some(serde_json::json!({
                                    "recording_id": &recording_id_clone,
                                    "diarizer": diarizer_record.as_deref(),
                                    "speaker_count": result.speakers.len(),
                                    "speaker_segment_count": result.segments.len(),
                                })),
                            )
                        };
                        match update_result {
                            Ok(true) => {
                                transcript.segments = enriched_segments;
                                diarization_updated = true;
                                // Only once labels are actually stored: a
                                // notice about which model produced them is a
                                // lie if none were produced. Only the local
                                // branch can substitute a model, so a provider
                                // pass carries no notice.
                                if diarizer == MeetingDiarizer::Local {
                                    diarization_fallback_notice = resolved_local_model
                                        .as_ref()
                                        .and_then(|resolved| resolved.fallback_notice.clone());
                                    // Voiceprints, on the same terms as the
                                    // manual run: only when the switch is on,
                                    // and best effort -- a meeting is not
                                    // failed by a voice that could not be
                                    // remembered. The signature is recorded
                                    // under the model that actually ran
                                    // (`local_diarization_model_id`, which may
                                    // be the fallback, not the requested one):
                                    // a centroid filed under the wrong
                                    // embedder would be compared across
                                    // embedding spaces, which is exactly what
                                    // the matcher refuses to do. Only this
                                    // branch: a provider pass returns labels,
                                    // not embeddings.
                                    let voice_settings = {
                                        let sm = state_clone.settings_manager.lock().await;
                                        sm.settings().meetings.clone()
                                    };
                                    if voice_settings.remember_voices {
                                        if let Err(error) = store_and_match_cluster_voices(
                                            state_clone.as_ref(),
                                            &recording_id_clone,
                                            &local_diarization_model_id,
                                            &result.cluster_centroids,
                                            voice_settings.auto_apply_confident_voices,
                                        )
                                        .await
                                        {
                                            tracing::warn!(
                                                "Voice matching after diarization of {} did not finish: {}",
                                                recording_id_clone,
                                                error
                                            );
                                        }
                                    }
                                }
                            }
                            Ok(false) => tracing::warn!(
                                "Skipped diarization enrichment for {} because the transcript changed while diarization was running",
                                recording_id_clone
                            ),
                            Err(error) => tracing::warn!(
                                "Diarization completed for {} but enriched transcript persistence failed: {}",
                                recording_id_clone,
                                error
                            ),
                        }
                    }
                    Some(Err(error)) => tracing::warn!(
                        "Best-effort diarization failed for {}: {}",
                        recording_id_clone,
                        error
                    ),
                }

                let db = state_clone.db.lock().await;
                if let Ok(Some(latest_transcript)) = db.get_transcript(&recording_id_clone) {
                    transcript = latest_transcript;
                }
            }

            match completion_result {
                Err(error) => {
                    tracing::error!(
                        "Failed to finalize completed transcript for {}: {}",
                        recording_id_clone,
                        error
                    );
                    handle_clone.emit_event(
                        "recording-status-changed",
                        serde_json::json!({
                            "recordingId": &recording_id_clone,
                            "status": "error",
                            "message": format!("Failed to finalize transcript: {}", error),
                            "updatedAt": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                }
                Ok(()) => {
                    if diarization_updated {
                        handle_clone.emit_event(
                            "transcript-updated",
                            serde_json::json!({
                                "recordingId": &recording_id_clone,
                                "reason": "diarization",
                                "updatedAt": chrono::Utc::now().to_rfc3339(),
                            }),
                        );
                        // The completed event has already gone out (completion
                        // is durable before diarization starts), so a model
                        // substitution rides the same "a finished meeting can
                        // still carry a note" path the degraded transcript uses.
                        if let Some(notice) = diarization_fallback_notice.as_deref() {
                            tracing::warn!(
                                "Diarization for {} fell back to the default model: {}",
                                recording_id_clone,
                                notice
                            );
                            handle_clone.emit_event(
                                "recording-status-changed",
                                serde_json::json!({
                                    "recordingId": &recording_id_clone,
                                    "status": "completed",
                                    "message": notice,
                                    "updatedAt": chrono::Utc::now().to_rfc3339(),
                                }),
                            );
                        }
                    }

                    report_provider_cleanup_warnings(
                        state_clone.as_ref(),
                        Some((&handle_clone, recording_id_clone.as_str())),
                    )
                    .await;

                    if let Some(reason) = degraded_reason.as_deref() {
                        tracing::warn!(
                            "Meeting {} completed with a degraded transcript: {}",
                            recording_id_clone,
                            reason
                        );
                        let mut db = state_clone.db.lock().await;
                        if let Err(error) = db.log_audit_event(
                            "meeting_transcript_degraded",
                            Some(serde_json::json!({
                                "recording_id": &recording_id_clone,
                                "reason": reason,
                            })),
                            "warning",
                        ) {
                            tracing::warn!(
                                "Failed to log degraded transcript for {}: {}",
                                recording_id_clone,
                                error
                            );
                        }
                    }

                    if let Err(error) = apply_meeting_transcript_only_storage_policy(
                        state_clone.as_ref(),
                        Some(&handle_clone),
                        "meeting-post-processing-finished",
                        Some(&recording_id_clone),
                    )
                    .await
                    {
                        tracing::warn!(
                            "Failed to apply transcript-only storage policy for {}: {}",
                            recording_id_clone,
                            error
                        );
                    }

                    let full_text = transcript.full_text.clone();
                    let auto_analyze = {
                        let sm = state_clone.settings_manager.lock().await;
                        sm.settings().transcription.enable_auto_analysis
                    };

                    if auto_analyze && !full_text.trim().is_empty() {
                        let state_analysis = Arc::clone(&state_clone);
                        let handle_analysis = handle_clone.clone();
                        let rec_id_analysis = recording_id_clone.clone();
                        tokio::spawn(async move {
                            run_meeting_analysis_pass(
                                state_analysis.as_ref(),
                                &handle_analysis,
                                &rec_id_analysis,
                            )
                            .await;
                        });
                    } else {
                        // No analysis pass will run, so nothing else will name
                        // this meeting. Title it from the transcript directly
                        // rather than leaving the placeholder in place.
                        match auto_name_meeting_recording(
                            state_clone.as_ref(),
                            &handle_clone,
                            &recording_id_clone,
                            None,
                            true,
                        )
                        .await
                        {
                            Ok(Some(title)) => {
                                tracing::info!(
                                    "Auto-named meeting '{}' to '{}'",
                                    recording_id_clone,
                                    title
                                )
                            }
                            Ok(None) => {}
                            Err(e) => tracing::warn!(
                                "Meeting auto-name failed for '{}': {}",
                                recording_id_clone,
                                e
                            ),
                        }
                    }

                    if let Err(error) = enforce_meeting_retention_policy(
                        state_clone.as_ref(),
                        None::<&crate::sidecar_handle::SidecarHandle>,
                        "meeting-completed",
                        None,
                    )
                    .await
                    {
                        tracing::warn!(
                            "Failed to enforce meeting retention after {} completed: {}",
                            recording_id_clone,
                            error
                        );
                    }
                }
            }
        }
        Err(e) => {
            if !meeting_pipeline_failure_should_be_persisted(
                state_clone.sidecar_shutting_down.load(Ordering::SeqCst),
            ) {
                tracing::info!(
                    "Meeting transcription for {} was interrupted by sidecar shutdown; leaving it processing for startup recovery",
                    recording_id_clone
                );
                return;
            }
            tracing::error!("Failed to transcribe {}: {}", recording_id_clone, e);
            {
                let mut db = state_clone.db.lock().await;
                if let Err(error) = db.update_recording_status(&recording_id_clone, "error") {
                    tracing::error!(
                        "Failed to persist transcription error status for {}: {}",
                        recording_id_clone,
                        error
                    );
                }
                if let Err(error) = db.log_audit_event(
                    "transcription_failed",
                    Some(serde_json::json!({"recording_id": &recording_id_clone, "error": &e})),
                    "error",
                ) {
                    tracing::warn!(
                        "Failed to log transcription error for {}: {}",
                        recording_id_clone,
                        error
                    );
                }
            }
            handle_clone.emit_event(
                "recording-status-changed",
                serde_json::json!({
                    "recordingId": &recording_id_clone, "status": "error",
                    "message": &e, "updatedAt": chrono::Utc::now().to_rfc3339(),
                }),
            );
            emit_meeting_lifecycle_phase(
                state_clone.as_ref(),
                &handle_clone,
                "error",
                &recording_id_clone,
                Some(&e),
            );
        }
    }

    let terminal_phase = {
        let db = state_clone.db.lock().await;
        match db.get_recording(&recording_id_clone) {
            Ok(Some(recording)) if recording.status == "completed" => "ready",
            _ => "error",
        }
    };
    // A retranscription may finish while another meeting is capturing. Update
    // only the overlay that still owns this identifier, and retain the terminal
    // state so a renderer remount cannot erase recovery information.
    let terminal_update =
        state_clone
            .recording_overlay_state
            .lock()
            .ok()
            .and_then(|mut overlay| {
                if overlay.recording_id.as_deref() != Some(recording_id_clone.as_str()) {
                    return None;
                }
                if overlay.phase == terminal_phase {
                    return None;
                }
                overlay.phase = terminal_phase.to_string();
                overlay.dismissed = false;
                overlay.message = Some(if terminal_phase == "ready" {
                    "Meeting transcript is ready".to_string()
                } else {
                    "Meeting processing failed. Open Meetings to retry from saved audio."
                        .to_string()
                });
                Some(overlay.message.clone())
            });
    if let Some(message) = terminal_update {
        handle_clone.emit_event(
            "meeting-recording-state-changed",
            serde_json::json!({
                "phase": terminal_phase,
                "recordingId": &recording_id_clone,
                "message": message,
            }),
        );
    }
}

fn meeting_pipeline_failure_should_be_persisted(sidecar_shutting_down: bool) -> bool {
    !sidecar_shutting_down
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

    fn write_wav(path: &Path) {
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
                .write_sample(((index % 200) as i16 - 100) * 50)
                .expect("write sample");
        }
        writer.finalize().expect("finalize wav");
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
