use super::{EngineProbe, PlatformEngine};
use crate::asr::VocabularyHint;
use crate::dictation_parity::{VOCABULARY_HINT_MAX_CHARS, VOCABULARY_HINT_MAX_TERMS};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use anyhow::Context;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::ffi::OsString;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::path::PathBuf;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use std::time::Instant;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use tokio::process::Command as TokioCommand;
use tokio::sync::{mpsc, oneshot};

const HELPER_PROTOCOL_VERSION: u32 = 1;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const HELPER_BASE_NAME: &str = "nautilus-macos-speech-helper";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const HELPER_TARGET_NAME: &str = "nautilus-macos-speech-helper-aarch64-apple-darwin";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeechAuthorizationStatus {
    Authorized,
    NotDetermined,
    Denied,
    Restricted,
    Unavailable,
    Unknown(isize),
}

/// Which of the two Apple engines the helper will actually run.
///
/// `SpeechAnalyzer` (macOS 26+) is the purpose-built long-form on-device
/// engine: per-segment timestamps, volatile/finalized streaming, and no bytes
/// to download beyond the OS-managed locale assets. `SfSpeechRecognizer` is
/// the older path, which is all a macOS 13-15 install has and which returns no
/// usable segment timestamps.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppleSpeechEngine {
    SpeechAnalyzer,
    /// The default for anything that has not probed: an old macOS, a
    /// non-Apple-Silicon build, or a settings file written before this field
    /// existed all describe a machine that can only run SFSpeechRecognizer.
    #[default]
    SfSpeechRecognizer,
}

impl AppleSpeechEngine {
    /// The `--engine` value the helper accepts, and the value the helper's own
    /// probe reports.
    pub fn id(self) -> &'static str {
        match self {
            Self::SpeechAnalyzer => "speech_analyzer",
            Self::SfSpeechRecognizer => "sf_speech_recognizer",
        }
    }

    /// The framework name, for copy that has to say which engine runs.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::SpeechAnalyzer => "SpeechAnalyzer",
            Self::SfSpeechRecognizer => "SFSpeechRecognizer",
        }
    }

    /// The inverse of `id`, for reading the engine the helper reported back.
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "speech_analyzer" => Some(Self::SpeechAnalyzer),
            "sf_speech_recognizer" => Some(Self::SfSpeechRecognizer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppleSpeechReadinessStatus {
    Ready,
    UnsupportedPlatform,
    HelperMissing,
    AuthorizationNotDetermined,
    AuthorizationDenied,
    AuthorizationRestricted,
    UnsupportedLocale,
    OnDeviceUnavailable,
    RecognizerUnavailable,
    UnknownAuthorization,
    RuntimeUnavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleSpeechReadiness {
    pub status: AppleSpeechReadinessStatus,
    pub ready: bool,
    pub platform_supported: bool,
    pub helper_present: bool,
    pub authorization: String,
    pub locale: Option<String>,
    pub locale_supported: bool,
    pub on_device_available: bool,
    pub recognizer_available: bool,
    pub message: String,
    pub setup_action: Option<String>,
    /// Whether the helper can actually run SpeechAnalyzer here: the macOS 26+
    /// API exists and `SpeechTranscriber` reports itself usable.
    #[serde(default)]
    pub speech_analyzer_available: bool,
    /// Whether SpeechAnalyzer supports the requested locale at all.
    #[serde(default)]
    pub speech_analyzer_locale_supported: bool,
    /// Whether that locale's assets are on disk. Nothing is downloaded to make
    /// this true; the Models screen's "Install language" action is what asks
    /// macOS for them.
    #[serde(default)]
    pub speech_analyzer_assets_installed: bool,
    /// Raw asset state from `AssetInventory`, plus the helper's
    /// `installed_not_allocated` case: macOS only reports `installed` once the
    /// locale is allocated to the process, and that allocation does not
    /// survive the helper exiting.
    #[serde(default)]
    pub speech_analyzer_asset_status: String,
    /// Every locale SpeechAnalyzer supports on this Mac, from
    /// `SpeechTranscriber.supportedLocales` at probe time.
    #[serde(default)]
    pub speech_analyzer_locales: Vec<String>,
    /// The subset of those whose assets macOS already has.
    #[serde(default)]
    pub speech_analyzer_installed_locales: Vec<String>,
    /// The engine this route will run for the probed locale.
    #[serde(default)]
    pub engine: AppleSpeechEngine,
    /// The OS version string reported by the helper (e.g. "26.0.0").
    #[serde(default)]
    pub operating_system_version: Option<String>,
}

/// Which engine the Apple Speech route runs for the probed locale.
///
/// Pure so the decision is testable without a Mac: SpeechAnalyzer only when
/// the helper reports the API usable, the locale supported, and its assets
/// already on disk. Anything else is the SFSpeechRecognizer path, which is
/// what every macOS 13-15 install gets.
pub fn selected_engine(readiness: &AppleSpeechReadiness) -> AppleSpeechEngine {
    if readiness.speech_analyzer_available
        && readiness.speech_analyzer_locale_supported
        && readiness.speech_analyzer_assets_installed
    {
        AppleSpeechEngine::SpeechAnalyzer
    } else {
        AppleSpeechEngine::SfSpeechRecognizer
    }
}

/// Whether the Apple Speech route may serve meetings.
///
/// A meeting transcript is assembled from per-chunk segments with real
/// start/end times (`transcribe_recording_in_chunks` offsets and merges them).
/// Only the SpeechAnalyzer path returns those; SFSpeechRecognizer returns one
/// formatted string, so it stays dictation-only exactly as before.
pub fn supports_meetings(readiness: &AppleSpeechReadiness) -> bool {
    readiness.ready && selected_engine(readiness) == AppleSpeechEngine::SpeechAnalyzer
}

/// How long a language install may run in total before the helper is killed.
///
/// Generous on purpose: the download is Apple's, over the reader's connection,
/// at a size this app does not control. The point is that a wedged helper
/// eventually dies rather than holding a child process and the "Installing
/// language…" button for the life of the app.
pub const INSTALL_TOTAL_BUDGET: Duration = Duration::from_secs(20 * 60);

/// How long the install may go without saying anything before it is killed.
///
/// The helper emits `progress` lines as macOS reports them, so silence this
/// long means it is no longer making progress, not that the download is
/// merely large.
pub const INSTALL_PROGRESS_IDLE: Duration = Duration::from_secs(3 * 60);

/// How long a live session may go with no helper output at all -- no partial,
/// no error, no exit -- before the helper is killed. Silence is normal in
/// dictation; silence for this long is a wedged process.
pub const LIVE_HELPER_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

/// How long to wait for a killed or finished helper to actually exit before
/// killing it again and stopping the wait.
pub const HELPER_EXIT_GRACE: Duration = Duration::from_secs(5);

/// How often the install loop wakes to notice a cancel or an expired wait.
/// Short enough that "Cancel" feels immediate, long enough to be free.
pub const INSTALL_CANCEL_POLL: Duration = Duration::from_millis(250);

/// Why a language install stopped waiting on the helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallWaitExpiry {
    /// The whole install ran past `INSTALL_TOTAL_BUDGET`.
    TotalBudget,
    /// No progress line for `INSTALL_PROGRESS_IDLE`.
    NoProgress,
}

impl InstallWaitExpiry {
    pub fn message(self) -> &'static str {
        match self {
            Self::TotalBudget => {
                "The macOS language install ran too long and was stopped. Try again, or install the language from System Settings."
            }
            Self::NoProgress => {
                "The macOS language install stopped reporting progress and was stopped. Try again, or install the language from System Settings."
            }
        }
    }
}

/// Whether a language install has waited long enough to give up.
///
/// Pure, so the policy is testable without a Mac or a real download: the two
/// clocks are passed in rather than read.
pub fn install_wait_expiry(
    total_elapsed: Duration,
    since_last_progress: Duration,
) -> Option<InstallWaitExpiry> {
    if total_elapsed >= INSTALL_TOTAL_BUDGET {
        return Some(InstallWaitExpiry::TotalBudget);
    }
    if since_last_progress >= INSTALL_PROGRESS_IDLE {
        return Some(InstallWaitExpiry::NoProgress);
    }
    None
}

/// Set by `cancel_language_install`, cleared when an install starts.
///
/// A flag rather than a channel because the install is a single OS-owned
/// operation with one button behind it: there is nothing to route, and the
/// reader who pressed "Cancel" is the same one who pressed "Install".
static APPLE_SPEECH_INSTALL_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Asks the running language install to stop. Safe to call when none is
/// running: the next install clears the flag before it spawns.
pub fn cancel_language_install() {
    APPLE_SPEECH_INSTALL_CANCELLED.store(true, Ordering::Relaxed);
}

/// Reads and clears the cancel flag.
fn take_install_cancellation() -> bool {
    APPLE_SPEECH_INSTALL_CANCELLED.swap(false, Ordering::Relaxed)
}

/// The exact error a cancelled install returns, so callers that have to tell
/// "stopped on purpose" from "failed" can assert against it rather than
/// rebuilding the payload.
pub fn install_language_cancelled_error() -> anyhow::Error {
    typed_error(
        "cancelled",
        "The macOS language install was cancelled.",
        false,
    )
}

/// Refuses a helper result that did not come from the engine the caller
/// required.
///
/// Two ways the contract can break, and both are silent without this: the
/// helper reports a different engine than the one it was told to run, or it
/// reports SpeechAnalyzer and returns no timed segments. Either one produces a
/// text-only result, and a text-only result reaching the meeting chunker
/// becomes a saved transcript with zero timestamps and no error anywhere.
///
/// Pure, so the contract is testable without a Mac.
pub fn engine_mismatch_refusal(
    required_engine: Option<AppleSpeechEngine>,
    reported_engine: Option<&str>,
    segment_count: usize,
) -> Option<anyhow::Error> {
    let required = required_engine?;
    if reported_engine != Some(required.id()) {
        return Some(typed_error_with_details(
            "engine_mismatch",
            format!(
                "Apple Speech ran {} after {} was required, so the transcript has no usable timestamps.",
                reported_engine
                    .and_then(AppleSpeechEngine::from_id)
                    .map(AppleSpeechEngine::display_name)
                    .unwrap_or("an unknown engine"),
                required.display_name()
            ),
            true,
            BTreeMap::from([
                ("required_engine".to_string(), required.id().to_string()),
                (
                    "reported_engine".to_string(),
                    reported_engine.unwrap_or("unknown").to_string(),
                ),
            ]),
        ));
    }
    if required == AppleSpeechEngine::SpeechAnalyzer && segment_count == 0 {
        return Some(typed_error_with_details(
            "engine_mismatch",
            "Apple Speech reported SpeechAnalyzer but returned no timed segments, so the transcript has no usable timestamps."
                .to_string(),
            true,
            BTreeMap::from([("required_engine".to_string(), required.id().to_string())]),
        ));
    }
    None
}

/// What the last readiness probe found about the Apple Speech meeting route.
///
/// Three states, not two: "nothing has probed yet" is not the same answer as
/// "probed, and this Mac cannot serve meetings", and collapsing them is what
/// made a perfectly capable macOS 26 Mac drop Apple Speech from the meeting
/// candidates until something else happened to refresh the inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppleSpeechMeetingCapability {
    /// No probe has run in this process yet.
    Unknown,
    Supported,
    Unsupported,
}

const MEETING_CAPABILITY_UNKNOWN: u8 = 0;
const MEETING_CAPABILITY_SUPPORTED: u8 = 1;
const MEETING_CAPABILITY_UNSUPPORTED: u8 = 2;

/// Set by every readiness probe so the meeting-route policy can ask whether
/// Apple Speech is meeting-capable without spawning the helper on a hot path.
static SPEECH_ANALYZER_MEETING_CAPABILITY: AtomicU8 = AtomicU8::new(MEETING_CAPABILITY_UNKNOWN);

/// What the process currently knows, without looking.
pub fn meeting_capability() -> AppleSpeechMeetingCapability {
    match SPEECH_ANALYZER_MEETING_CAPABILITY.load(Ordering::Relaxed) {
        MEETING_CAPABILITY_SUPPORTED => AppleSpeechMeetingCapability::Supported,
        MEETING_CAPABILITY_UNSUPPORTED => AppleSpeechMeetingCapability::Unsupported,
        _ => AppleSpeechMeetingCapability::Unknown,
    }
}

fn store_meeting_capability(supported: bool) {
    SPEECH_ANALYZER_MEETING_CAPABILITY.store(
        if supported {
            MEETING_CAPABILITY_SUPPORTED
        } else {
            MEETING_CAPABILITY_UNSUPPORTED
        },
        Ordering::Relaxed,
    );
}

/// The meeting-capability policy, with the probe passed in so it is testable
/// without a Mac.
///
/// `Unknown` means nothing has looked yet, and the honest response to that is
/// to look -- not to answer "no". Answering "no" is what dropped Apple Speech
/// from the meeting candidates before any inventory refresh and then refused
/// it with a message about macOS 26 that had never been checked.
pub fn resolve_meeting_capability(
    cached: AppleSpeechMeetingCapability,
    probe: impl FnOnce() -> bool,
) -> bool {
    match cached {
        AppleSpeechMeetingCapability::Supported => true,
        AppleSpeechMeetingCapability::Unsupported => false,
        AppleSpeechMeetingCapability::Unknown => probe(),
    }
}

/// Whether the Apple Speech route may serve meetings.
///
/// Reads the flag every readiness probe refreshes; when nothing has probed
/// yet, it runs one bounded probe (`readiness()` spawns the helper with a
/// 10-second timeout and coalesces concurrent callers) and remembers the
/// answer, so the cost is paid at most once per process.
pub fn meetings_supported() -> bool {
    resolve_meeting_capability(meeting_capability(), || {
        let supported = supports_meetings(&readiness());
        store_meeting_capability(supported);
        supported
    })
}

/// Test-only: pin the capability so a policy test can assert both branches
/// instead of only whichever one the machine running the suite happens to be.
#[cfg(test)]
pub fn set_meeting_capability_for_test(capability: AppleSpeechMeetingCapability) {
    SPEECH_ANALYZER_MEETING_CAPABILITY.store(
        match capability {
            AppleSpeechMeetingCapability::Unknown => MEETING_CAPABILITY_UNKNOWN,
            AppleSpeechMeetingCapability::Supported => MEETING_CAPABILITY_SUPPORTED,
            AppleSpeechMeetingCapability::Unsupported => MEETING_CAPABILITY_UNSUPPORTED,
        },
        Ordering::Relaxed,
    );
}

/// Progress from an in-flight language-asset install.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppleSpeechAssetProgress {
    pub stage: String,
    pub locale: String,
    pub fraction: f64,
    pub message: String,
}

/// The result of a language-asset install.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppleSpeechAssetInstall {
    pub locale: String,
    pub installed: bool,
    pub asset_status: String,
    pub engine: AppleSpeechEngine,
}

/// A locale identifier the helper will accept as a command-line argument.
///
/// The value reaches here from the renderer, and it is passed to a process as
/// an argument, so it is matched against the shape of a BCP-47/ICU identifier
/// rather than merely escaped: anything with a dash-dash prefix, a path
/// separator, or whitespace is refused outright instead of being handed to the
/// helper's argument parser.
pub fn is_valid_locale_argument(locale: &str) -> bool {
    !locale.is_empty()
        && locale.len() <= 32
        && locale.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
        && locale
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
}

/// The vocabulary terms to hand the Apple Speech helper for one request.
///
/// Both Apple engines take a bias list -- `SFSpeechRecognitionRequest`
/// `contextualStrings` on the older one, `AnalysisContext.contextualStrings`
/// on SpeechAnalyzer -- so the dictionary hint the whisper and cloud routes
/// already receive reaches this route too. The caps mirror
/// `dictation_parity`'s: the builder there already applies them, and applying
/// them again here means a hint arriving from anywhere else cannot exceed what
/// the helper is prepared to take. Terms are counted, not the framing, because
/// there is no prompt frame on this path.
pub fn contextual_strings_for_helper(hint: Option<&VocabularyHint>) -> Vec<String> {
    let Some(hint) = hint else {
        return Vec::new();
    };
    let mut accepted: Vec<String> = Vec::new();
    let mut characters = 0usize;
    for term in hint.terms() {
        let term = term.split_whitespace().collect::<Vec<_>>().join(" ");
        if term.is_empty() || term.chars().any(char::is_control) {
            continue;
        }
        if accepted.len() >= VOCABULARY_HINT_MAX_TERMS {
            break;
        }
        let length = term.chars().count();
        if characters + length > VOCABULARY_HINT_MAX_CHARS {
            break;
        }
        characters += length;
        accepted.push(term);
    }
    accepted
}

/// The JSON body the helper reads from `--contextual-strings-file`.
///
/// Serialized rather than hand-built so the field names cannot drift from what
/// the Swift side decodes.
#[derive(Debug, Serialize)]
struct ContextualStringsRequest<'a> {
    protocol_version: u32,
    contextual_strings: &'a [String],
}

/// A private temp file holding one request's vocabulary terms, deleted when it
/// goes out of scope.
///
/// The terms are the user's own dictionary entries, so they never travel as
/// process arguments -- an argument list is readable by every process on the
/// machine. The file is created `0600` and only its path is passed.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
struct ContextualStringsFile {
    path: PathBuf,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl ContextualStringsFile {
    /// `None` when there are no terms: an empty list is the same as no file,
    /// and writing one anyway would put user text on disk for nothing.
    fn write(terms: &[String]) -> Result<Option<Self>> {
        use std::io::Write;

        if terms.is_empty() {
            return Ok(None);
        }
        let path = std::env::temp_dir().join(format!(
            "nautilus-speech-vocabulary-{}.json",
            uuid::Uuid::new_v4()
        ));
        let body = serde_json::to_vec(&ContextualStringsRequest {
            protocol_version: HELPER_PROTOCOL_VERSION,
            contextual_strings: terms,
        })
        .map_err(|error| {
            typed_error(
                "recognition_failed",
                format!("Could not encode the dictation vocabulary hint: {error}"),
                false,
            )
        })?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|error| {
            typed_error(
                "recognition_failed",
                format!("Could not stage the dictation vocabulary hint: {error}"),
                false,
            )
        })?;
        file.write_all(&body).map_err(|error| {
            typed_error(
                "recognition_failed",
                format!("Could not write the dictation vocabulary hint: {error}"),
                false,
            )
        })?;
        Ok(Some(Self { path }))
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl Drop for ContextualStringsFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// One timed span of a SpeechAnalyzer transcript.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MacosSpeechSegment {
    pub text: String,
    #[serde(default)]
    pub start_seconds: f64,
    #[serde(default)]
    pub end_seconds: f64,
    #[serde(default)]
    pub confidence: f64,
}

/// A finished Apple Speech transcription. `segments` is empty on the
/// SFSpeechRecognizer path, which has no usable segment ranges to report.
#[derive(Debug, Clone, Default)]
pub struct MacosSpeechTranscript {
    pub text: String,
    pub language: String,
    pub confidence: f64,
    pub engine: Option<String>,
    pub segments: Vec<MacosSpeechSegment>,
    /// Terms the helper reports it actually handed the recognizer. Read from
    /// the helper's own reply rather than from what was sent, so a helper too
    /// old to know the option reports zero and the audit log says the hint did
    /// not reach the recognizer instead of assuming it did.
    pub vocabulary_hint_terms_applied: usize,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[derive(Default)]
struct ReadinessProbeState {
    in_flight: bool,
    cached: Option<(Instant, AppleSpeechReadiness)>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static READINESS_PROBE_STATE: OnceLock<(Mutex<ReadinessProbeState>, Condvar)> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
struct HelperErrorPayload {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    code: String,
    message: String,
    retryable: bool,
    #[serde(default)]
    details: BTreeMap<String, String>,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
struct HelperProbePayload {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    authorization: String,
    authorization_code: isize,
    locale: String,
    locale_supported: bool,
    on_device_available: bool,
    recognizer_available: bool,
    #[serde(default)]
    speech_analyzer_available: bool,
    #[serde(default)]
    speech_analyzer_locale_supported: bool,
    #[serde(default)]
    speech_analyzer_assets_installed: bool,
    #[serde(default)]
    speech_analyzer_asset_status: String,
    #[serde(default)]
    speech_analyzer_locales: Vec<String>,
    #[serde(default)]
    speech_analyzer_installed_locales: Vec<String>,
    // The helper also reports the `engine` it would resolve. Rust does not
    // parse it: `selected_engine` recomputes the same decision from the facts
    // above, which is the version that can be tested without a Mac, and one
    // source of truth beats two that can drift.
    #[serde(default)]
    operating_system_version: Option<String>,
}

impl HelperProbePayload {
    /// Whether SpeechAnalyzer can run for the probed locale right now.
    fn speech_analyzer_usable(&self) -> bool {
        self.speech_analyzer_available
            && self.speech_analyzer_locale_supported
            && self.speech_analyzer_assets_installed
    }
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Debug, Clone, Deserialize)]
struct HelperAssetProgressPayload {
    protocol_version: u32,
    #[serde(rename = "type")]
    kind: String,
    stage: String,
    locale: String,
    fraction: f64,
    message: String,
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Debug, Clone, Deserialize)]
struct HelperAssetInstallPayload {
    locale: String,
    installed: bool,
    asset_status: String,
    engine: AppleSpeechEngine,
}

/// Parses one helper line as asset-install progress, or `None` for anything
/// else (the closing `asset_install` payload, a typed error, a blank line).
#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn parse_asset_progress_line(line: &str) -> Option<AppleSpeechAssetProgress> {
    let payload = serde_json::from_str::<HelperAssetProgressPayload>(line).ok()?;
    if payload.protocol_version != HELPER_PROTOCOL_VERSION || payload.kind != "progress" {
        return None;
    }
    Some(AppleSpeechAssetProgress {
        stage: payload.stage,
        locale: payload.locale,
        fraction: payload.fraction.clamp(0.0, 1.0),
        message: payload.message,
    })
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
#[derive(Debug, Clone, Deserialize)]
struct HelperTranscriptPayload {
    text: String,
    language: String,
    confidence: f64,
    is_final: bool,
    #[serde(default)]
    engine: Option<String>,
    #[serde(default)]
    contextual_strings_applied: usize,
    #[serde(default)]
    segments: Vec<MacosSpeechSegment>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LiveSpeechEvent {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub event: String,
    pub text: String,
    pub language: String,
    pub confidence: f64,
    pub is_final: bool,
}

/// One SpeechAnalyzer live event, exactly as the helper emits it on
/// `--live --engine speech_analyzer`.
///
/// `volatile` spans are the model's current guess for audio it has not
/// finalized and are replaced wholesale by the next event; `finalized` spans
/// never change again.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct SpeechAnalyzerLiveEvent {
    pub protocol_version: u32,
    #[serde(rename = "type")]
    pub payload_type: String,
    pub kind: String,
    pub text: String,
    pub language: String,
    #[serde(default)]
    pub start_seconds: f64,
    #[serde(default)]
    pub end_seconds: f64,
    #[serde(default)]
    pub confidence: f64,
}

impl SpeechAnalyzerLiveEvent {
    pub fn is_finalized(&self) -> bool {
        self.kind == "finalized"
    }
}

/// A streaming dictation partial: text that will not change again, plus the
/// model's current guess for the tail.
///
/// This is the shape the streaming dictation path consumes. Nothing in the
/// sidecar drives it yet -- the live streaming session is not wired to
/// dictation -- so it exists here as the seam the helper side is tested
/// against.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StreamingPartial {
    pub stable_prefix: String,
    pub volatile_suffix: String,
}

impl StreamingPartial {
    /// The whole preview, stable text first.
    pub fn combined_text(&self) -> String {
        match (
            self.stable_prefix.is_empty(),
            self.volatile_suffix.is_empty(),
        ) {
            (true, _) => self.volatile_suffix.clone(),
            (_, true) => self.stable_prefix.clone(),
            _ => format!("{} {}", self.stable_prefix, self.volatile_suffix),
        }
    }
}

/// Receives streaming partials. The consumer lives outside this module; this
/// trait is the plug point so the helper side and its accumulator can land and
/// be tested independently.
pub trait StreamingPartialSink: Send {
    fn accept_partial(&mut self, partial: StreamingPartial);
}

/// Folds the helper's volatile/finalized events into a growing stable prefix
/// and a replaceable volatile tail.
#[derive(Debug, Default)]
pub struct SpeechAnalyzerPartialAccumulator {
    stable_prefix: String,
    volatile_suffix: String,
}

impl SpeechAnalyzerPartialAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies one event and returns the partial it produces.
    ///
    /// A finalized span is appended to the stable prefix and clears the
    /// volatile tail, because SpeechAnalyzer finalizes the span the volatile
    /// guess covered. A volatile span replaces the tail outright.
    pub fn apply(&mut self, event: &SpeechAnalyzerLiveEvent) -> StreamingPartial {
        if event.is_finalized() {
            append_transcript_piece(&mut self.stable_prefix, &event.text);
            self.volatile_suffix.clear();
        } else {
            self.volatile_suffix = event.text.clone();
        }
        self.snapshot()
    }

    pub fn snapshot(&self) -> StreamingPartial {
        StreamingPartial {
            stable_prefix: self.stable_prefix.trim().to_string(),
            volatile_suffix: self.volatile_suffix.trim().to_string(),
        }
    }

    /// The finalized transcript so far, with the volatile guess discarded.
    pub fn finalized_text(&self) -> String {
        self.stable_prefix.trim().to_string()
    }
}

/// Joins one transcript span onto another, respecting the leading space
/// SpeechAnalyzer already puts on continuation spans.
fn append_transcript_piece(target: &mut String, piece: &str) {
    if piece.trim().is_empty() {
        return;
    }
    if target.is_empty() {
        target.push_str(piece.trim_start());
        return;
    }
    if !target.ends_with(' ') && !piece.starts_with(' ') {
        target.push(' ');
    }
    target.push_str(piece);
}

/// Parses one helper line as a SpeechAnalyzer live event, or `None` when the
/// line is something else (a typed error, the closing `final`, a blank line).
pub fn parse_speech_analyzer_live_line(line: &str) -> Option<SpeechAnalyzerLiveEvent> {
    let event = serde_json::from_str::<SpeechAnalyzerLiveEvent>(line).ok()?;
    if event.protocol_version == HELPER_PROTOCOL_VERSION
        && event.payload_type == "live"
        && matches!(event.kind.as_str(), "volatile" | "finalized")
    {
        Some(event)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct LiveSpeechResult {
    pub text: String,
    pub language: String,
    pub confidence: f64,
}

pub struct LiveSpeechAudioSink {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    sender: mpsc::UnboundedSender<Vec<f32>>,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
impl LiveSpeechAudioSink {
    pub fn send_chunk(&self, chunk: Vec<f32>) -> Result<()> {
        self.sender.send(chunk).map_err(|_| {
            typed_error(
                "cancelled",
                "Apple live dictation audio stream is closed.",
                false,
            )
        })
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
impl LiveSpeechAudioSink {
    pub fn send_chunk(&self, _chunk: Vec<f32>) -> Result<()> {
        Err(typed_error(
            "helper_missing",
            "Apple live dictation is unavailable in this build.",
            false,
        ))
    }
}

fn typed_error(code: &str, message: impl Into<String>, retryable: bool) -> anyhow::Error {
    typed_error_with_details(code, message, retryable, BTreeMap::new())
}

fn typed_error_with_details(
    code: &str,
    message: impl Into<String>,
    retryable: bool,
    details: BTreeMap<String, String>,
) -> anyhow::Error {
    let payload = HelperErrorPayload {
        protocol_version: HELPER_PROTOCOL_VERSION,
        kind: "error".to_string(),
        code: code.to_string(),
        message: message.into(),
        retryable,
        details,
    };
    anyhow::anyhow!(serialize_helper_error(&payload))
}

fn serialize_helper_error(payload: &HelperErrorPayload) -> String {
    serde_json::to_string(payload).unwrap_or_else(|_| {
        format!(
            "{{\"protocol_version\":1,\"type\":\"error\",\"code\":\"{}\",\"message\":\"macOS Speech helper error\",\"retryable\":false,\"details\":{{}}}}",
            payload.code
        )
    })
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn parse_helper_error_line(line: &str) -> Option<HelperErrorPayload> {
    let payload = serde_json::from_str::<HelperErrorPayload>(line).ok()?;
    if payload.protocol_version == HELPER_PROTOCOL_VERSION && payload.kind == "error" {
        Some(payload)
    } else {
        None
    }
}

/// The typed code inside one of this module's errors, when it carries one.
///
/// The errors serialize their payload as their message, so a caller that needs
/// to tell "the reader cancelled" from "the install failed" can read the code
/// rather than matching on prose.
pub fn typed_error_code(error: &anyhow::Error) -> Option<String> {
    parse_helper_error_line(&error.to_string()).map(|payload| payload.code)
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn parse_single_payload<T>(bytes: &[u8], expected_kind: &str) -> Result<T>
where
    T: for<'de> Deserialize<'de>,
{
    let text = String::from_utf8_lossy(bytes);
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| {
            typed_error(
                "recognition_failed",
                "macOS Speech helper returned no JSON payload.",
                true,
            )
        })?;

    if let Some(error) = parse_helper_error_line(line) {
        return Err(anyhow::anyhow!(serialize_helper_error(&error)));
    }

    let value: serde_json::Value = serde_json::from_str(line).map_err(|error| {
        typed_error(
            "recognition_failed",
            format!("macOS Speech helper returned malformed JSON: {error}"),
            true,
        )
    })?;
    let version = value
        .get("protocol_version")
        .and_then(serde_json::Value::as_u64);
    let kind = value.get("type").and_then(serde_json::Value::as_str);
    if version != Some(HELPER_PROTOCOL_VERSION as u64) || kind != Some(expected_kind) {
        return Err(typed_error_with_details(
            "recognition_failed",
            "macOS Speech helper returned an unexpected protocol payload.",
            true,
            BTreeMap::from([
                ("expected_type".to_string(), expected_kind.to_string()),
                ("payload".to_string(), line.to_string()),
            ]),
        ));
    }

    serde_json::from_value(value).map_err(|error| {
        typed_error(
            "recognition_failed",
            format!("macOS Speech helper payload did not match the Rust contract: {error}"),
            true,
        )
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn human_error_message(error: &anyhow::Error) -> String {
    serde_json::from_str::<HelperErrorPayload>(&error.to_string())
        .map(|payload| format!("{} ({})", payload.message, payload.code))
        .unwrap_or_else(|_| error.to_string())
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn readiness_from_probe(payload: &HelperProbePayload) -> AppleSpeechReadiness {
    let authorization = map_authorization_status_payload(payload);
    let (status, message, setup_action) = match authorization {
        SpeechAuthorizationStatus::NotDetermined => (
            AppleSpeechReadinessStatus::AuthorizationNotDetermined,
            "Speech Recognition permission has not been decided.".to_string(),
            Some(
                "Request Speech Recognition permission from the installed Plainsong app. It records your consent to on-device processing; both Apple engines run on this Mac with Apple's server fallback off."
                    .to_string(),
            ),
        ),
        SpeechAuthorizationStatus::Denied => (
            AppleSpeechReadinessStatus::AuthorizationDenied,
            "Speech Recognition permission is denied.".to_string(),
            Some(
                "Enable Plainsong in System Settings > Privacy & Security > Speech Recognition. It records your consent to on-device processing; both Apple engines run on this Mac with Apple's server fallback off."
                    .to_string(),
            ),
        ),
        SpeechAuthorizationStatus::Restricted => (
            AppleSpeechReadinessStatus::AuthorizationRestricted,
            "Speech Recognition permission is restricted by system policy.".to_string(),
            Some("Ask the device administrator to allow Speech Recognition, or choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Unknown(code) => (
            AppleSpeechReadinessStatus::UnknownAuthorization,
            format!("macOS returned an unknown Speech Recognition authorization status ({code})."),
            Some("Re-check Speech Recognition permission or choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Unavailable => (
            AppleSpeechReadinessStatus::RuntimeUnavailable,
            "Speech Recognition authorization is unavailable.".to_string(),
            Some("Choose another dictation provider.".to_string()),
        ),
        // SpeechAnalyzer is checked first because it does not depend on any of
        // the SFSpeechRecognizer facts below: a locale SFSpeechRecognizer
        // cannot serve on-device is still transcribable when SpeechAnalyzer
        // supports it and its assets are installed.
        SpeechAuthorizationStatus::Authorized if payload.speech_analyzer_usable() => (
            AppleSpeechReadinessStatus::Ready,
            format!(
                "Apple Speech is ready for on-device transcription in locale '{}' through SpeechAnalyzer, with nothing to download.",
                payload.locale
            ),
            None,
        ),
        SpeechAuthorizationStatus::Authorized if !payload.locale_supported => (
            AppleSpeechReadinessStatus::UnsupportedLocale,
            format!("Apple Speech does not support locale '{}'.", payload.locale),
            Some("Choose a supported macOS speech locale or another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized if !payload.on_device_available => (
            AppleSpeechReadinessStatus::OnDeviceUnavailable,
            format!(
                "On-device Apple Speech is unavailable for locale '{}'; server fallback is disabled.",
                payload.locale
            ),
            Some("Choose another on-device dictation provider or a locale with on-device Apple Speech support.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized if !payload.recognizer_available => (
            AppleSpeechReadinessStatus::RecognizerUnavailable,
            "Apple Speech is temporarily unavailable on this Mac.".to_string(),
            Some("Try again after macOS finishes preparing Speech Recognition, or choose another dictation provider.".to_string()),
        ),
        SpeechAuthorizationStatus::Authorized => (
            AppleSpeechReadinessStatus::Ready,
            format!(
                "Apple Speech is ready for on-device dictation in locale '{}' through SFSpeechRecognizer.",
                payload.locale
            ),
            None,
        ),
    };

    let mut readiness = AppleSpeechReadiness {
        status,
        ready: status == AppleSpeechReadinessStatus::Ready,
        platform_supported: true,
        helper_present: true,
        authorization: payload.authorization.clone(),
        locale: Some(payload.locale.clone()),
        locale_supported: payload.locale_supported,
        on_device_available: payload.on_device_available,
        recognizer_available: payload.recognizer_available,
        message,
        setup_action,
        speech_analyzer_available: payload.speech_analyzer_available,
        speech_analyzer_locale_supported: payload.speech_analyzer_locale_supported,
        speech_analyzer_assets_installed: payload.speech_analyzer_assets_installed,
        speech_analyzer_asset_status: payload.speech_analyzer_asset_status.clone(),
        speech_analyzer_locales: payload.speech_analyzer_locales.clone(),
        speech_analyzer_installed_locales: payload.speech_analyzer_installed_locales.clone(),
        engine: AppleSpeechEngine::SfSpeechRecognizer,
        operating_system_version: payload.operating_system_version.clone(),
    };
    readiness.engine = selected_engine(&readiness);
    readiness
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn readiness_from_probe_error(error: &anyhow::Error) -> AppleSpeechReadiness {
    let typed = serde_json::from_str::<HelperErrorPayload>(&error.to_string()).ok();
    let helper_missing = typed
        .as_ref()
        .map(|payload| matches!(payload.code.as_str(), "helper_missing" | "helper_untrusted"))
        .unwrap_or(false);
    AppleSpeechReadiness {
        status: if helper_missing {
            AppleSpeechReadinessStatus::HelperMissing
        } else {
            AppleSpeechReadinessStatus::RuntimeUnavailable
        },
        ready: false,
        platform_supported: true,
        helper_present: !helper_missing,
        authorization: "unavailable".to_string(),
        locale: None,
        locale_supported: false,
        on_device_available: false,
        recognizer_available: false,
        message: typed
            .as_ref()
            .map(|payload| payload.message.clone())
            .unwrap_or_else(|| human_error_message(error)),
        setup_action: Some(if helper_missing {
            "Reinstall Plainsong so the required macOS Speech helper is present and executable."
                .to_string()
        } else {
            "Re-check Apple Speech readiness or choose another dictation provider.".to_string()
        }),
        speech_analyzer_available: false,
        speech_analyzer_locale_supported: false,
        speech_analyzer_assets_installed: false,
        speech_analyzer_asset_status: String::new(),
        speech_analyzer_locales: Vec::new(),
        speech_analyzer_installed_locales: Vec::new(),
        engine: AppleSpeechEngine::SfSpeechRecognizer,
        operating_system_version: None,
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn readiness_with_policy(force_refresh: bool) -> AppleSpeechReadiness {
    const SHARED_RESULT_WINDOW: Duration = Duration::from_millis(500);
    let (mutex, condition) = READINESS_PROBE_STATE
        .get_or_init(|| (Mutex::new(ReadinessProbeState::default()), Condvar::new()));
    let mut state = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    loop {
        if state.in_flight {
            state = condition
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !state.in_flight {
                if let Some((_, readiness)) = &state.cached {
                    return readiness.clone();
                }
            }
            continue;
        }
        if !force_refresh {
            if let Some((probed_at, readiness)) = &state.cached {
                if probed_at.elapsed() <= SHARED_RESULT_WINDOW {
                    return readiness.clone();
                }
            }
        }
        state.in_flight = true;
        break;
    }
    drop(state);

    let readiness = helper_probe(false)
        .map(|payload| readiness_from_probe(&payload))
        .unwrap_or_else(|error| readiness_from_probe_error(&error));

    // The meeting-route policy reads this flag instead of spawning the helper
    // on a route-resolution path; every probe refreshes it.
    store_meeting_capability(supports_meetings(&readiness));

    let mut state = mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    state.in_flight = false;
    state.cached = Some((Instant::now(), readiness.clone()));
    condition.notify_all();
    readiness
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn readiness() -> AppleSpeechReadiness {
    readiness_with_policy(false)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn fresh_readiness() -> AppleSpeechReadiness {
    readiness_with_policy(true)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn invalidate_readiness_cache() {
    if let Some((mutex, _)) = READINESS_PROBE_STATE.get() {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cached = None;
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn readiness() -> AppleSpeechReadiness {
    AppleSpeechReadiness {
        status: AppleSpeechReadinessStatus::UnsupportedPlatform,
        ready: false,
        platform_supported: false,
        helper_present: false,
        authorization: "unavailable".to_string(),
        locale: None,
        locale_supported: false,
        on_device_available: false,
        recognizer_available: false,
        message: "Apple Speech dictation requires macOS on Apple Silicon.".to_string(),
        setup_action: Some("Choose a dictation provider supported on this platform.".to_string()),
        speech_analyzer_available: false,
        speech_analyzer_locale_supported: false,
        speech_analyzer_assets_installed: false,
        speech_analyzer_asset_status: String::new(),
        speech_analyzer_locales: Vec::new(),
        speech_analyzer_installed_locales: Vec::new(),
        engine: AppleSpeechEngine::SfSpeechRecognizer,
        operating_system_version: None,
    }
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn fresh_readiness() -> AppleSpeechReadiness {
    readiness()
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn invalidate_readiness_cache() {}

pub fn probe() -> EngineProbe {
    probe_from_readiness(&readiness())
}

pub fn probe_from_readiness(readiness: &AppleSpeechReadiness) -> EngineProbe {
    let mut notes = vec![readiness.message.clone()];
    if let Some(action) = readiness.setup_action.clone() {
        notes.push(action);
    }
    EngineProbe {
        engine: PlatformEngine::MacosAppleSpeech,
        ready: readiness.ready,
        notes,
    }
}

/// Transcribes one file through the Apple Speech helper.
///
/// `required_engine` is the engine the *caller's* decision depends on. Passing
/// it skips the engine re-decision here and holds the helper to it: the
/// meeting gate reads a cached capability flag and this function used to probe
/// again, so an asset or reservation change in between could route a meeting
/// to SFSpeechRecognizer, which returns no segments -- a saved transcript with
/// zero timestamps and no error anywhere. `None` keeps the old behaviour for
/// dictation, where either engine is a correct answer.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn transcribe_file(
    audio_path: &Path,
    required_engine: Option<AppleSpeechEngine>,
    contextual_strings: &[String],
) -> Result<MacosSpeechTranscript> {
    let probe = authorized_probe(false)?;
    // Named explicitly rather than left to the helper's own `auto`, so the
    // engine that runs is the one this side decided and reported.
    let engine = match required_engine {
        Some(engine) => engine,
        None if probe.speech_analyzer_usable() => AppleSpeechEngine::SpeechAnalyzer,
        None => AppleSpeechEngine::SfSpeechRecognizer,
    };
    let helper = resolve_helper_binary_path()?;
    let mut arguments = vec![
        OsString::from("--transcribe-file"),
        audio_path.as_os_str().to_os_string(),
        OsString::from("--engine"),
        OsString::from(engine.id()),
    ];
    append_configured_locale(&mut arguments);
    // Held for the whole call: dropping it deletes the file, and the helper
    // reads it after this function has already returned from `write`.
    let vocabulary_file = ContextualStringsFile::write(contextual_strings)?;
    if let Some(file) = vocabulary_file.as_ref() {
        arguments.push(OsString::from("--contextual-strings-file"));
        arguments.push(file.path().as_os_str().to_os_string());
    }
    let output =
        run_helper_with_timeout(&helper, &arguments, helper_timeout_for_audio(audio_path))?;
    if !output.status.success() {
        return Err(helper_failure_from_output(
            &output,
            "recognition_failed",
            "macOS Speech helper failed during file transcription.",
        ));
    }

    let payload: HelperTranscriptPayload = parse_single_payload(&output.stdout, "transcript")?;
    if !payload.is_final || payload.text.trim().is_empty() {
        return Err(typed_error(
            "recognition_failed",
            "macOS Speech helper returned an empty or non-final transcript.",
            true,
        ));
    }
    if let Some(message) = engine_mismatch_refusal(
        required_engine,
        payload.engine.as_deref(),
        payload.segments.len(),
    ) {
        return Err(message);
    }

    Ok(MacosSpeechTranscript {
        text: payload.text,
        language: payload.language,
        confidence: payload.confidence,
        engine: payload.engine,
        segments: payload.segments,
        vocabulary_hint_terms_applied: payload.contextual_strings_applied,
    })
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn transcribe_file(
    _audio_path: &Path,
    _required_engine: Option<AppleSpeechEngine>,
    _contextual_strings: &[String],
) -> Result<MacosSpeechTranscript> {
    Err(typed_error(
        "helper_missing",
        "macOS Apple Speech native engine is unavailable in this build.",
        false,
    ))
}

/// Starts a live dictation session against one of the two engines.
///
/// The SFSpeechRecognizer stream reports one growing best guess as `partial`
/// events and one closing `final`. The SpeechAnalyzer stream additionally
/// reports `live` events -- volatile and finalized spans -- which are folded
/// into `StreamingPartial`s on the third channel; both streams end with the
/// same closing `final`, so a caller that only wants the finished text needs
/// no new parsing.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub async fn start_live_dictation_session(
    sample_rate: u32,
    engine: AppleSpeechEngine,
    contextual_strings: &[String],
) -> Result<(
    LiveSpeechAudioSink,
    mpsc::UnboundedReceiver<LiveSpeechEvent>,
    mpsc::UnboundedReceiver<StreamingPartial>,
    oneshot::Receiver<Result<LiveSpeechResult, String>>,
)> {
    ensure_speech_authorized(false)?;
    let helper = resolve_helper_binary_path()?;
    let mut command = TokioCommand::new(&helper);
    command
        .arg("--live")
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .arg("--engine")
        .arg(engine.id());
    if let Some(locale) = configured_locale() {
        command.arg("--locale").arg(locale);
    }
    // A live session outlives this function, so the file has to as well: it is
    // moved into the task that reaps the child and dropped when the session
    // ends, which is the only point at which the helper can no longer read it.
    let vocabulary_file = ContextualStringsFile::write(contextual_strings)?;
    if let Some(file) = vocabulary_file.as_ref() {
        command
            .arg("--contextual-strings-file")
            .arg(file.path().as_os_str());
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "Failed to start macOS Speech live helper at '{}'",
                helper.display()
            )
        })?;

    let stdin = child.stdin.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stdin is unavailable.",
            false,
        )
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stdout is unavailable.",
            false,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stderr is unavailable.",
            false,
        )
    })?;

    let (audio_tx, mut audio_rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let (event_tx, event_rx) = mpsc::unbounded_channel::<LiveSpeechEvent>();
    let (partial_tx, partial_rx) = mpsc::unbounded_channel::<StreamingPartial>();
    let (final_tx, final_rx) = oneshot::channel::<Result<LiveSpeechResult, String>>();

    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(chunk) = audio_rx.recv().await {
            let mut bytes = Vec::with_capacity(chunk.len() * std::mem::size_of::<f32>());
            for sample in chunk {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            if let Err(error) = stdin.write_all(&bytes).await {
                tracing::warn!("Failed writing Apple live dictation audio chunk: {}", error);
                break;
            }
        }
        let _ = stdin.shutdown().await;
    });

    tokio::spawn(async move {
        // Moved in so the vocabulary file outlives the helper that reads it and
        // is deleted when the session ends, whichever way it ends.
        let _vocabulary_file = vocabulary_file;
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut stderr_text = String::new();
            let _ = reader.read_to_string(&mut stderr_text).await;
            stderr_text
        });

        let mut lines = BufReader::new(stdout).lines();
        let mut final_tx = Some(final_tx);
        let mut terminal_message: Option<String> = None;
        let mut final_sent = false;
        let mut accumulator = SpeechAnalyzerPartialAccumulator::new();

        loop {
            // Unbounded before: a helper that stopped saying anything held the
            // child process, both channels and this task until the app quit.
            // Silence is normal in dictation, so the window is generous; what
            // it catches is a wedged process, not a quiet speaker.
            let line = match tokio::time::timeout(LIVE_HELPER_IDLE_TIMEOUT, lines.next_line()).await
            {
                Ok(Ok(Some(line))) => line,
                Ok(_) => break,
                Err(_) => {
                    terminal_message = Some(
                        typed_error_with_details(
                            "timeout",
                            "Apple live dictation stopped responding and was ended.",
                            true,
                            BTreeMap::from([
                                ("operation".to_string(), "live_dictation".to_string()),
                                (
                                    "idle_seconds".to_string(),
                                    LIVE_HELPER_IDLE_TIMEOUT.as_secs().to_string(),
                                ),
                            ]),
                        )
                        .to_string(),
                    );
                    let _ = child.kill().await;
                    break;
                }
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Some(error) = parse_helper_error_line(&line) {
                terminal_message = Some(serialize_helper_error(&error));
                break;
            }
            // SpeechAnalyzer volatile/finalized spans. A finalized span is not
            // the end of the session -- SpeechAnalyzer finalizes many of them
            // -- so these never close the final channel.
            if let Some(event) = parse_speech_analyzer_live_line(&line) {
                let _ = partial_tx.send(accumulator.apply(&event));
                continue;
            }

            match serde_json::from_str::<LiveSpeechEvent>(&line) {
                Ok(payload)
                    if payload.protocol_version == HELPER_PROTOCOL_VERSION
                        && matches!(payload.kind.as_str(), "partial" | "final") =>
                {
                    let is_final =
                        payload.is_final || payload.kind == "final" || payload.event == "final";
                    let _ = event_tx.send(payload.clone());
                    if is_final {
                        if payload.text.trim().is_empty() {
                            terminal_message = Some(
                                typed_error(
                                    "recognition_failed",
                                    "macOS Speech live helper returned an empty final transcript.",
                                    true,
                                )
                                .to_string(),
                            );
                        } else if let Some(sender) = final_tx.take() {
                            let _ = sender.send(Ok(LiveSpeechResult {
                                text: payload.text,
                                language: payload.language,
                                confidence: payload.confidence,
                            }));
                            final_sent = true;
                        }
                        break;
                    }
                }
                Ok(_) => {
                    terminal_message = Some(
                        typed_error(
                            "recognition_failed",
                            "macOS Speech live helper returned an unexpected protocol payload.",
                            true,
                        )
                        .to_string(),
                    );
                    break;
                }
                Err(error) => {
                    terminal_message = Some(
                        typed_error(
                            "recognition_failed",
                            format!("Failed to parse macOS Speech live helper output: {error}"),
                            true,
                        )
                        .to_string(),
                    );
                    break;
                }
            }
        }

        let child_status = reap_helper(&mut child).await;
        let stderr_text = stderr_task.await.unwrap_or_default();
        if !final_sent {
            let status_note = child_status
                .and_then(|status| status.code().map(|code| format!("exit code {code}")))
                .unwrap_or_else(|| "unknown exit status".to_string());
            let message = terminal_message.unwrap_or_else(|| {
                let stderr_text = stderr_text.trim();
                if stderr_text.is_empty() {
                    typed_error(
                        "recognition_failed",
                        format!(
                            "macOS Speech live helper ended without a final transcript ({status_note})."
                        ),
                        true,
                    )
                    .to_string()
                } else {
                    typed_error_with_details(
                        "recognition_failed",
                        "macOS Speech live helper failed without a typed error.",
                        true,
                        BTreeMap::from([("stderr".to_string(), stderr_text.to_string())]),
                    )
                    .to_string()
                }
            });
            if let Some(sender) = final_tx.take() {
                let _ = sender.send(Err(message));
            }
        }
    });

    Ok((
        LiveSpeechAudioSink { sender: audio_tx },
        event_rx,
        partial_rx,
        final_rx,
    ))
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub async fn start_live_dictation_session(
    _sample_rate: u32,
    _engine: AppleSpeechEngine,
    _contextual_strings: &[String],
) -> Result<(
    LiveSpeechAudioSink,
    mpsc::UnboundedReceiver<LiveSpeechEvent>,
    mpsc::UnboundedReceiver<StreamingPartial>,
    oneshot::Receiver<Result<LiveSpeechResult, String>>,
)> {
    Err(typed_error(
        "helper_missing",
        "Apple live dictation is unavailable in this build.",
        false,
    ))
}

/// Asks macOS to download and install the SpeechAnalyzer assets for one
/// locale, reporting progress as it goes.
///
/// This is the only path that downloads anything. Transcription never does:
/// it refuses with `assets_not_installed` and leaves the choice to the reader,
/// because a language pack is the OS's download, on the reader's disk, at a
/// size this app does not control.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub async fn install_language_assets<F>(
    locale: Option<&str>,
    mut on_progress: F,
) -> Result<AppleSpeechAssetInstall>
where
    F: FnMut(AppleSpeechAssetProgress),
{
    // A cancel that arrived while nothing was installing must not cancel the
    // install the reader just asked for.
    take_install_cancellation();
    let helper = resolve_helper_binary_path()?;
    let mut command = TokioCommand::new(&helper);
    command.arg("--install-assets");
    let requested_locale = locale
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .or_else(configured_locale);
    if let Some(locale) = requested_locale {
        if !is_valid_locale_argument(&locale) {
            return Err(typed_error_with_details(
                "malformed_request",
                "That is not a valid language identifier.",
                false,
                BTreeMap::from([("locale".to_string(), locale)]),
            ));
        }
        command.arg("--locale").arg(locale);
    }

    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| {
            format!(
                "Failed to start the macOS Speech helper at '{}' to install language assets",
                helper.display()
            )
        })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stdout is unavailable.",
            false,
        )
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        typed_error(
            "helper_missing",
            "macOS Speech helper stderr is unavailable.",
            false,
        )
    })?;
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut text = String::new();
        let _ = reader.read_to_string(&mut text).await;
        text
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut install: Option<AppleSpeechAssetInstall> = None;
    let mut helper_error: Option<anyhow::Error> = None;
    // Neither layer used to bound this: the Swift helper blocks on a semaphore
    // with no deadline, and this loop awaited the next line forever. An
    // install that macOS never finished held a child process, the progress
    // event stream and the "Installing language…" button for the life of the
    // app, with no way to stop it.
    let started = Instant::now();
    let mut last_progress = Instant::now();
    let mut stop_reason: Option<anyhow::Error> = None;
    loop {
        if take_install_cancellation() {
            stop_reason = Some(install_language_cancelled_error());
            break;
        }
        let line = match tokio::time::timeout(INSTALL_CANCEL_POLL, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            // The helper closed stdout, or the pipe broke: fall through to the
            // exit handling below, which reports whatever it did or did not say.
            Ok(_) => break,
            Err(_) => {
                if let Some(expiry) =
                    install_wait_expiry(started.elapsed(), last_progress.elapsed())
                {
                    stop_reason = Some(typed_error_with_details(
                        "timeout",
                        expiry.message(),
                        true,
                        BTreeMap::from([
                            ("operation".to_string(), "install_assets".to_string()),
                            (
                                "waited_seconds".to_string(),
                                started.elapsed().as_secs().to_string(),
                            ),
                        ]),
                    ));
                    break;
                }
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(error) = parse_helper_error_line(&line) {
            helper_error = Some(anyhow::anyhow!(serialize_helper_error(&error)));
            break;
        }
        if let Some(progress) = parse_asset_progress_line(&line) {
            last_progress = Instant::now();
            on_progress(progress);
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<HelperAssetInstallPayload>(&line) {
            install = Some(AppleSpeechAssetInstall {
                locale: payload.locale,
                installed: payload.installed,
                asset_status: payload.asset_status,
                engine: payload.engine,
            });
            // The helper emits this line and exits, so waiting for stdout to
            // close would risk the liveness window expiring on a finished
            // install and reporting a timeout for work that succeeded.
            break;
        }
    }

    if stop_reason.is_some() {
        let _ = child.kill().await;
    }
    let status = reap_helper(&mut child).await;
    let stderr_text = stderr_task.await.unwrap_or_default();
    invalidate_readiness_cache();

    if let Some(error) = stop_reason {
        return Err(error);
    }
    if let Some(error) = helper_error {
        return Err(error);
    }
    install.ok_or_else(|| {
        let mut details = BTreeMap::from([(
            "exit_code".to_string(),
            status
                .and_then(|status| status.code())
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string()),
        )]);
        let stderr_text = stderr_text.trim();
        if !stderr_text.is_empty() {
            details.insert("stderr".to_string(), stderr_text.to_string());
        }
        typed_error_with_details(
            "asset_install_failed",
            "The macOS language install ended without a result.",
            true,
            details,
        )
    })
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub async fn install_language_assets<F>(
    _locale: Option<&str>,
    _on_progress: F,
) -> Result<AppleSpeechAssetInstall>
where
    F: FnMut(AppleSpeechAssetProgress),
{
    Err(typed_error(
        "helper_missing",
        "Installing Apple Speech languages requires macOS on Apple Silicon.",
        false,
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn ensure_speech_authorized(prompt_if_needed: bool) -> Result<()> {
    authorized_probe(prompt_if_needed).map(|_| ())
}

/// The authorization gate, returning the probe it already had to run so
/// callers do not spawn the helper twice to learn which engine will serve
/// them.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn authorized_probe(prompt_if_needed: bool) -> Result<HelperProbePayload> {
    if prompt_if_needed && !is_packaged_app_context() {
        return Err(typed_error(
            "authorization_not_determined",
            "Speech Recognition permission must be requested from the packaged Plainsong app.",
            false,
        ));
    }

    let payload = helper_probe(prompt_if_needed)?;
    match map_authorization_status_payload(&payload) {
        SpeechAuthorizationStatus::Authorized => {}
        SpeechAuthorizationStatus::NotDetermined => {
            return Err(typed_error(
                "authorization_not_determined",
                "Speech Recognition permission has not been decided. Request it explicitly before transcription.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Denied => {
            return Err(typed_error(
                "authorization_denied",
                "macOS Speech permission is denied. Enable Plainsong in System Settings > Privacy & Security > Speech Recognition.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Restricted => {
            return Err(typed_error(
                "authorization_restricted",
                "macOS Speech permission is restricted by system policy.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Unavailable => {
            return Err(typed_error(
                "helper_missing",
                "macOS Apple Speech native engine is unavailable in this build.",
                false,
            ));
        }
        SpeechAuthorizationStatus::Unknown(code) => {
            return Err(typed_error_with_details(
                "recognition_failed",
                "macOS returned an unknown Speech Recognition authorization status.",
                false,
                BTreeMap::from([("authorization_code".to_string(), code.to_string())]),
            ));
        }
    }

    // The three checks below are SFSpeechRecognizer's. A locale it cannot
    // serve on-device is still transcribable when SpeechAnalyzer supports it
    // and its assets are installed, so they are skipped in that case rather
    // than refusing a route that works.
    if payload.speech_analyzer_usable() {
        return Ok(payload);
    }
    if !payload.locale_supported {
        return Err(typed_error_with_details(
            "unsupported_locale",
            "Apple Speech does not support the requested locale.",
            false,
            BTreeMap::from([("locale".to_string(), payload.locale)]),
        ));
    }
    if !payload.on_device_available {
        return Err(typed_error_with_details(
            "on_device_unavailable",
            "On-device Apple Speech recognition is unavailable for this locale or device; server fallback is disabled.",
            false,
            BTreeMap::from([("locale".to_string(), payload.locale)]),
        ));
    }
    if !payload.recognizer_available {
        return Err(typed_error_with_details(
            "recognition_failed",
            "Apple Speech recognition is temporarily unavailable.",
            true,
            BTreeMap::from([("locale".to_string(), payload.locale)]),
        ));
    }
    Ok(payload)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn ensure_speech_authorized(_prompt_if_needed: bool) -> Result<()> {
    Err(typed_error(
        "helper_missing",
        "macOS Apple Speech native engine is unavailable in this build.",
        false,
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    helper_probe(false)
        .map(|payload| map_authorization_status_payload(&payload))
        .unwrap_or(SpeechAuthorizationStatus::Unavailable)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
pub fn speech_authorization_status() -> SpeechAuthorizationStatus {
    SpeechAuthorizationStatus::Unavailable
}

/// Waits for a helper to exit, killing it if it will not.
///
/// `child.wait()` on its own is unbounded, so a helper that ignored the first
/// kill (or finished its stdout and then hung) would keep this task alive
/// forever after the reader had already been told the operation ended.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
async fn reap_helper(child: &mut tokio::process::Child) -> Option<std::process::ExitStatus> {
    reap_helper_within(child, HELPER_EXIT_GRACE).await
}

/// `reap_helper` with the grace passed in, so a test can prove the kill
/// without waiting the production window.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
async fn reap_helper_within(
    child: &mut tokio::process::Child,
    grace: Duration,
) -> Option<std::process::ExitStatus> {
    match tokio::time::timeout(grace, child.wait()).await {
        Ok(status) => status.ok(),
        Err(_) => {
            let _ = child.kill().await;
            match tokio::time::timeout(grace, child.wait()).await {
                Ok(status) => status.ok(),
                Err(_) => {
                    tracing::warn!("macOS Speech helper did not exit after being killed");
                    None
                }
            }
        }
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn helper_probe(prompt_if_needed: bool) -> Result<HelperProbePayload> {
    let helper = resolve_helper_binary_path()?;
    let mut arguments = vec![OsString::from(if prompt_if_needed {
        "--request-authorization"
    } else {
        "--probe"
    })];
    append_configured_locale(&mut arguments);
    let timeout = if prompt_if_needed {
        Duration::from_secs(25)
    } else {
        Duration::from_secs(10)
    };
    let output = run_helper_with_timeout(&helper, &arguments, timeout)?;
    if !output.status.success() {
        return Err(helper_failure_from_output(
            &output,
            "recognition_failed",
            "macOS Speech capability probe failed.",
        ));
    }
    parse_single_payload(&output.stdout, "probe")
}

#[cfg(any(test, all(target_os = "macos", target_arch = "aarch64")))]
fn map_authorization_status_payload(payload: &HelperProbePayload) -> SpeechAuthorizationStatus {
    match payload.authorization.trim() {
        "authorized" => SpeechAuthorizationStatus::Authorized,
        "not_determined" => SpeechAuthorizationStatus::NotDetermined,
        "denied" => SpeechAuthorizationStatus::Denied,
        "restricted" => SpeechAuthorizationStatus::Restricted,
        "unavailable" => SpeechAuthorizationStatus::Unavailable,
        _ => SpeechAuthorizationStatus::Unknown(payload.authorization_code),
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn helper_timeout_for_audio(audio_path: &Path) -> Duration {
    let duration_secs = hound::WavReader::open(audio_path)
        .ok()
        .map(|reader| {
            let spec = reader.spec();
            if spec.sample_rate == 0 {
                0.0
            } else {
                reader.duration() as f64 / spec.sample_rate as f64
            }
        })
        .unwrap_or(0.0);
    Duration::from_secs(((duration_secs * 3.0).ceil() as u64 + 20).clamp(20, 490))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn run_helper_with_timeout(
    helper: &Path,
    arguments: &[OsString],
    timeout: Duration,
) -> Result<Output> {
    let mut child = Command::new(helper)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            typed_error_with_details(
                "helper_missing",
                "Failed to start the required macOS Speech helper.",
                false,
                BTreeMap::from([
                    ("path".to_string(), helper.display().to_string()),
                    ("error".to_string(), error.to_string()),
                ]),
            )
        })?;

    let started = Instant::now();
    loop {
        if child
            .try_wait()
            .with_context(|| "Failed while waiting for the macOS Speech helper")?
            .is_some()
        {
            return child.wait_with_output().map_err(|error| {
                typed_error(
                    "recognition_failed",
                    format!("Failed to capture macOS Speech helper output: {error}"),
                    true,
                )
            });
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(typed_error_with_details(
                "timeout",
                "macOS Speech helper timed out.",
                true,
                BTreeMap::from([("timeout_seconds".to_string(), timeout.as_secs().to_string())]),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn helper_failure_from_output(
    output: &Output,
    fallback_code: &str,
    fallback_message: &str,
) -> anyhow::Error {
    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Some(error) = stdout.lines().rev().find_map(parse_helper_error_line) {
        return anyhow::anyhow!(serialize_helper_error(&error));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let mut details = BTreeMap::from([(
        "exit_code".to_string(),
        output
            .status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string()),
    )]);
    if !stderr.is_empty() {
        details.insert("stderr".to_string(), stderr);
    }
    typed_error_with_details(fallback_code, fallback_message, true, details)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn is_packaged_app_context() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    exe.ancestors().any(|ancestor| {
        ancestor
            .extension()
            .map(|extension| extension.eq_ignore_ascii_case("app"))
            .unwrap_or(false)
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn configured_locale() -> Option<String> {
    std::env::var("PLAINSONG_APPLE_SPEECH_LOCALE")
        .ok()
        .map(|locale| locale.trim().to_string())
        .filter(|locale| !locale.is_empty())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn append_configured_locale(arguments: &mut Vec<OsString>) {
    if let Some(locale) = configured_locale() {
        arguments.push(OsString::from("--locale"));
        arguments.push(OsString::from(locale));
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn resolve_helper_binary_path() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|error| {
        typed_error_with_details(
            "helper_missing",
            "Could not locate the running Plainsong sidecar.",
            false,
            BTreeMap::from([("error".to_string(), error.to_string())]),
        )
    })?;
    resolve_helper_binary_path_for_executable(&executable)
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn resolve_helper_binary_path_for_executable(executable: &Path) -> Result<PathBuf> {
    if let Some(app_root) = packaged_app_root(executable) {
        let candidate = app_root
            .join("Contents")
            .join("Resources")
            .join("sidecar")
            .join(HELPER_TARGET_NAME);
        validate_packaged_helper(executable, &app_root, &candidate)?;
        return Ok(candidate);
    }

    let mut candidates = Vec::new();
    if let Some(directory) = executable.parent() {
        candidates.push(directory.join(HELPER_BASE_NAME));
        candidates.push(directory.join(HELPER_TARGET_NAME));
    }

    let binaries_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    candidates.push(binaries_dir.join(HELPER_BASE_NAME));
    candidates.push(binaries_dir.join(HELPER_TARGET_NAME));

    for candidate in &candidates {
        if is_executable_file(candidate) {
            return Ok(candidate.clone());
        }
    }

    Err(typed_error_with_details(
        "helper_missing",
        "The required macOS Speech helper is missing or not executable.",
        false,
        BTreeMap::from([(
            "searched".to_string(),
            candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
        )]),
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn packaged_app_root(executable: &Path) -> Option<PathBuf> {
    executable.ancestors().find_map(|ancestor| {
        ancestor
            .extension()
            .filter(|extension| extension.eq_ignore_ascii_case("app"))
            .map(|_| ancestor.to_path_buf())
    })
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn validate_packaged_helper(executable: &Path, app_root: &Path, helper: &Path) -> Result<()> {
    let helper_metadata = std::fs::symlink_metadata(helper).map_err(|error| {
        typed_error_with_details(
            "helper_missing",
            "The packaged macOS Speech helper is missing or unreadable.",
            false,
            BTreeMap::from([
                ("path".to_string(), helper.display().to_string()),
                ("error".to_string(), error.to_string()),
            ]),
        )
    })?;
    if helper_metadata.file_type().is_symlink() || !is_executable_file(helper) {
        return Err(typed_error_with_details(
            "helper_untrusted",
            "The packaged macOS Speech helper is not a trusted executable file.",
            false,
            BTreeMap::from([("path".to_string(), helper.display().to_string())]),
        ));
    }

    let canonical_app_root = app_root.canonicalize().map_err(|error| {
        packaged_helper_trust_error(
            helper,
            format!("Could not resolve the packaged app bundle: {error}"),
        )
    })?;
    let canonical_helper = helper.canonicalize().map_err(|error| {
        packaged_helper_trust_error(
            helper,
            format!("Could not resolve the packaged Speech helper: {error}"),
        )
    })?;
    let expected_directory = canonical_app_root
        .join("Contents")
        .join("Resources")
        .join("sidecar");
    if canonical_helper.parent() != Some(expected_directory.as_path())
        || canonical_helper.file_name().and_then(|name| name.to_str()) != Some(HELPER_TARGET_NAME)
    {
        return Err(packaged_helper_trust_error(
            helper,
            "The macOS Speech helper resolved outside its fixed app-bundle location.",
        ));
    }

    verify_code_signature(executable, "Plainsong sidecar")?;
    verify_code_signature(helper, "macOS Speech helper")?;

    let sidecar_team = code_signature_team_identifier(executable)?;
    let helper_team = code_signature_team_identifier(helper)?;
    if sidecar_team != helper_team {
        return Err(typed_error_with_details(
            "helper_untrusted",
            "The packaged macOS Speech helper is not signed by the same team as the Plainsong sidecar.",
            false,
            BTreeMap::from([
                (
                    "sidecar_team".to_string(),
                    sidecar_team.unwrap_or_else(|| "not set".to_string()),
                ),
                (
                    "helper_team".to_string(),
                    helper_team.unwrap_or_else(|| "not set".to_string()),
                ),
            ]),
        ));
    }

    verify_packaged_helper_entitlements(helper)?;
    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn verify_code_signature(path: &Path, label: &str) -> Result<()> {
    let output = Command::new("/usr/bin/codesign")
        .env_clear()
        .args(["--verify", "--strict", "--verbose=2"])
        .arg(path)
        .output()
        .map_err(|error| {
            packaged_helper_trust_error(
                path,
                format!("Could not verify the {label} code signature: {error}"),
            )
        })?;
    if output.status.success() {
        return Ok(());
    }

    Err(packaged_helper_trust_error(
        path,
        format!(
            "The {label} code signature is invalid: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ),
    ))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn code_signature_team_identifier(path: &Path) -> Result<Option<String>> {
    let output = Command::new("/usr/bin/codesign")
        .env_clear()
        .args(["-dv", "--verbose=4"])
        .arg(path)
        .output()
        .map_err(|error| {
            packaged_helper_trust_error(
                path,
                format!("Could not inspect the code-signing identity: {error}"),
            )
        })?;
    if !output.status.success() {
        return Err(packaged_helper_trust_error(
            path,
            format!(
                "Could not inspect the code-signing identity: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    let signing_text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(signing_text.lines().find_map(|line| {
        line.strip_prefix("TeamIdentifier=")
            .map(str::trim)
            .filter(|team| !team.is_empty() && *team != "not set")
            .map(ToString::to_string)
    }))
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn verify_packaged_helper_entitlements(helper: &Path) -> Result<()> {
    let output = Command::new("/usr/bin/codesign")
        .env_clear()
        .args(["-d", "--entitlements", ":-"])
        .arg(helper)
        .output()
        .map_err(|error| {
            packaged_helper_trust_error(
                helper,
                format!("Could not inspect the Speech helper entitlements: {error}"),
            )
        })?;
    let entitlements = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    const SPEECH_ENTITLEMENT: &str = "com.apple.security.personal-information.speech-recognition";
    const FORBIDDEN_ENTITLEMENTS: [&str; 7] = [
        "com.apple.security.device.audio-input",
        "com.apple.security.device.microphone",
        "com.apple.security.automation.apple-events",
        "com.apple.security.temporary-exception.apple-events",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
    ];
    if !output.status.success()
        || !entitlements.contains(SPEECH_ENTITLEMENT)
        || FORBIDDEN_ENTITLEMENTS
            .iter()
            .any(|entitlement| entitlements.contains(entitlement))
    {
        return Err(packaged_helper_trust_error(
            helper,
            "The packaged Speech helper does not carry the expected Speech-only entitlement set.",
        ));
    }
    Ok(())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn packaged_helper_trust_error(helper: &Path, message: impl Into<String>) -> anyhow::Error {
    typed_error_with_details(
        "helper_untrusted",
        message,
        false,
        BTreeMap::from([("path".to_string(), helper.display().to_string())]),
    )
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_language_install, contextual_strings_for_helper, engine_mismatch_refusal,
        install_wait_expiry, map_authorization_status_payload, parse_helper_error_line,
        parse_single_payload, parse_speech_analyzer_live_line, readiness_from_probe,
        resolve_meeting_capability, selected_engine, serialize_helper_error, supports_meetings,
        take_install_cancellation, typed_error, AppleSpeechEngine, AppleSpeechMeetingCapability,
        AppleSpeechReadiness, AppleSpeechReadinessStatus, HelperErrorPayload, HelperProbePayload,
        HelperTranscriptPayload, InstallWaitExpiry, SpeechAnalyzerLiveEvent,
        SpeechAnalyzerPartialAccumulator, SpeechAuthorizationStatus, StreamingPartial,
        StreamingPartialSink, HELPER_PROTOCOL_VERSION, INSTALL_PROGRESS_IDLE, INSTALL_TOTAL_BUDGET,
    };
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    use super::{
        reap_helper_within, resolve_helper_binary_path_for_executable, BufReader, Instant, Stdio,
        TokioCommand, HELPER_TARGET_NAME,
    };
    use std::time::Duration;
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    use tokio::io::AsyncBufReadExt;

    /// Every JSON literal below was captured verbatim from the compiled
    /// helper on this Mac (macOS 27.0, build 26A5406e, SDK 26.2) rather than
    /// hand-written, so the Rust contract is checked against what the helper
    /// actually emits.
    const HELPER_PROBE_CAPTURE: &[u8] = br#"{"authorization":"not_determined","authorization_code":0,"engine":"speech_analyzer","locale":"en_US","locale_supported":true,"on_device_available":true,"operating_system_version":"27.0.0","protocol_version":1,"recognizer_available":true,"speech_analyzer_asset_status":"installed_not_allocated","speech_analyzer_assets_installed":true,"speech_analyzer_available":true,"speech_analyzer_installed_locales":["en_AU","en_CA","en_GB","en_IE","en_IN","en_NZ","en_SG","en_US","en_ZA"],"speech_analyzer_locale_supported":true,"speech_analyzer_locales":["bn_IN","de_AT","de_CH","de_DE","en_AU","en_CA","en_GB","en_IE","en_IN","en_NZ","en_SG","en_US","en_ZA","es_CL","es_ES","es_MX","es_US","fr_BE","fr_CA","fr_CH","fr_FR","gu_IN","hi_IN","it_CH","it_IT","ja_JP","kn_IN","ko_KR","ks_IN","mai_IN","ml_IN","mr_IN","mul_IN","ne_IN","or_IN","pa_IN","pt_BR","pt_PT","ta_IN","te_IN","ur_IN","yue_CN","zh_CN","zh_HK","zh_TW"],"type":"probe"}"#;
    const HELPER_TRANSCRIPT_CAPTURE: &[u8] = br#"{"confidence":0.9627857142857145,"engine":"speech_analyzer","is_final":true,"language":"en_US","protocol_version":1,"segments":[{"confidence":0.9627857142857145,"end_seconds":5.3226875,"start_seconds":0,"text":"This is a Nautilus local quality gate sample with enough spoken words for verification."}],"text":"This is a Nautilus local quality gate sample with enough spoken words for verification.","type":"transcript"}"#;

    fn analyzer_readiness(
        speech_analyzer_available: bool,
        speech_analyzer_locale_supported: bool,
        speech_analyzer_assets_installed: bool,
        ready: bool,
    ) -> AppleSpeechReadiness {
        AppleSpeechReadiness {
            status: if ready {
                AppleSpeechReadinessStatus::Ready
            } else {
                AppleSpeechReadinessStatus::AuthorizationNotDetermined
            },
            ready,
            platform_supported: true,
            helper_present: true,
            authorization: if ready {
                "authorized"
            } else {
                "not_determined"
            }
            .to_string(),
            locale: Some("en_US".to_string()),
            locale_supported: true,
            on_device_available: true,
            recognizer_available: true,
            message: String::new(),
            setup_action: None,
            speech_analyzer_available,
            speech_analyzer_locale_supported,
            speech_analyzer_assets_installed,
            speech_analyzer_asset_status: String::new(),
            speech_analyzer_locales: Vec::new(),
            speech_analyzer_installed_locales: Vec::new(),
            engine: AppleSpeechEngine::SfSpeechRecognizer,
            operating_system_version: None,
        }
    }

    #[test]
    fn locale_arguments_are_validated_before_reaching_the_helper() {
        for valid in ["en_US", "fr-FR", "zh_Hant_TW", "yue_CN", "en"] {
            assert!(super::is_valid_locale_argument(valid), "{valid}");
        }
        // The value arrives from the renderer and becomes a process argument,
        // so anything that could be read as another flag or a path is refused
        // rather than escaped.
        for invalid in [
            "",
            "--engine",
            "-locale",
            "en US",
            "../etc/passwd",
            "en_US;rm -rf /",
            "en_US\n--engine",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(!super::is_valid_locale_argument(invalid), "{invalid:?}");
        }
    }

    #[test]
    fn asset_install_progress_lines_parse_and_other_lines_do_not() {
        // Captured verbatim from `--install-assets --locale en_US`.
        let progress = super::parse_asset_progress_line(
            r#"{"fraction":0,"locale":"en_US","message":"Checking which language assets macOS already has.","protocol_version":1,"stage":"checking","type":"progress"}"#,
        )
        .expect("captured progress line should parse");
        assert_eq!(progress.stage, "checking");
        assert_eq!(progress.locale, "en_US");
        assert_eq!(progress.fraction, 0.0);

        assert!(super::parse_asset_progress_line(
            r#"{"asset_status":"installed","engine":"speech_analyzer","installed":true,"locale":"en_US","protocol_version":1,"type":"asset_install"}"#
        )
        .is_none());
        assert!(super::parse_asset_progress_line("").is_none());
    }

    #[test]
    fn probe_contract_carries_the_speech_analyzer_asset_and_locale_fields() {
        let probe: HelperProbePayload = parse_single_payload(HELPER_PROBE_CAPTURE, "probe")
            .expect("the real helper probe should match the Rust contract");
        assert!(probe.speech_analyzer_available);
        assert!(probe.speech_analyzer_locale_supported);
        assert!(probe.speech_analyzer_assets_installed);
        // macOS reports `.supported` for a locale whose model is on disk until
        // the process allocates it, so the helper reports that case explicitly
        // instead of calling it a missing download.
        assert_eq!(
            probe.speech_analyzer_asset_status,
            "installed_not_allocated"
        );
        assert!(probe.speech_analyzer_locales.contains(&"ja_JP".to_string()));
        assert!(probe
            .speech_analyzer_installed_locales
            .contains(&"en_US".to_string()));
        assert!(probe.speech_analyzer_usable());

        // That capture has Speech Recognition permission still undecided, so
        // the route is not ready even though SpeechAnalyzer itself is usable.
        let readiness = readiness_from_probe(&probe);
        assert_eq!(
            readiness.status,
            AppleSpeechReadinessStatus::AuthorizationNotDetermined
        );
        assert_eq!(readiness.engine, AppleSpeechEngine::SpeechAnalyzer);
        assert!(!supports_meetings(&readiness));
        assert_eq!(
            readiness.speech_analyzer_locales.len(),
            probe.speech_analyzer_locales.len()
        );
    }

    #[test]
    fn an_authorized_speech_analyzer_probe_is_ready_and_meeting_capable() {
        let authorized = String::from_utf8(HELPER_PROBE_CAPTURE.to_vec())
            .expect("probe capture is UTF-8")
            .replace(
                "\"authorization\":\"not_determined\",\"authorization_code\":0",
                "\"authorization\":\"authorized\",\"authorization_code\":3",
            );
        let probe: HelperProbePayload = parse_single_payload(authorized.as_bytes(), "probe")
            .expect("authorized probe should parse");
        let readiness = readiness_from_probe(&probe);
        assert_eq!(readiness.status, AppleSpeechReadinessStatus::Ready);
        assert!(readiness.message.contains("SpeechAnalyzer"));
        assert!(readiness.message.contains("nothing to download"));
        assert_eq!(readiness.engine, AppleSpeechEngine::SpeechAnalyzer);
        assert!(supports_meetings(&readiness));
    }

    #[test]
    fn engine_selection_needs_the_api_the_locale_and_the_installed_assets() {
        for (available, locale_supported, assets_installed, expected) in [
            (true, true, true, AppleSpeechEngine::SpeechAnalyzer),
            (false, true, true, AppleSpeechEngine::SfSpeechRecognizer),
            (true, false, true, AppleSpeechEngine::SfSpeechRecognizer),
            (true, true, false, AppleSpeechEngine::SfSpeechRecognizer),
            (false, false, false, AppleSpeechEngine::SfSpeechRecognizer),
        ] {
            let readiness = analyzer_readiness(available, locale_supported, assets_installed, true);
            assert_eq!(selected_engine(&readiness), expected);
        }
    }

    #[test]
    fn meetings_need_a_ready_route_running_speech_analyzer() {
        assert!(supports_meetings(&analyzer_readiness(
            true, true, true, true
        )));
        // Not ready: permission still undecided.
        assert!(!supports_meetings(&analyzer_readiness(
            true, true, true, false
        )));
        // Ready, but on the SFSpeechRecognizer path, which returns no segment
        // timestamps and so stays dictation-only.
        assert!(!supports_meetings(&analyzer_readiness(
            false, false, false, true
        )));
    }

    /// "Nothing has probed yet" is not an answer, and treating it as "no" is
    /// what dropped Apple Speech from the meeting candidates on a Mac that
    /// could serve them, until some unrelated inventory refresh happened to
    /// run first.
    #[test]
    fn an_unprobed_meeting_capability_looks_instead_of_answering_no() {
        let mut probes = 0;
        assert!(resolve_meeting_capability(
            AppleSpeechMeetingCapability::Unknown,
            || {
                probes += 1;
                true
            }
        ));
        assert_eq!(probes, 1, "an unknown capability must probe exactly once");

        // A probe that ran and found nothing is a real answer; do not re-probe.
        assert!(!resolve_meeting_capability(
            AppleSpeechMeetingCapability::Unsupported,
            || panic!("a probed capability must not probe again")
        ));
        assert!(resolve_meeting_capability(
            AppleSpeechMeetingCapability::Supported,
            || panic!("a probed capability must not probe again")
        ));
    }

    /// Two captures from the same three-term hint on the same synthesized
    /// fixture, one per engine, taken on macOS 27.0 (26A5406e). They are kept
    /// together because the pair is the finding: both engines report the same
    /// three terms handed over, and only one of them changed its answer.
    /// SFSpeechRecognizer heard "Play song" without the hint and "Plainsong"
    /// with it; SpeechAnalyzer said "Plain song" either way.
    const HELPER_HINTED_SF_CAPTURE: &[u8] = br#"{"confidence":0.8448888858159384,"contextual_strings_applied":3,"engine":"sf_speech_recognizer","is_final":true,"language":"en_US","protocol_version":1,"segments":[],"text":"Plainsong exports every new to Obsidian before the stand-up","type":"transcript"}"#;
    const HELPER_HINTED_ANALYZER_CAPTURE: &[u8] = br#"{"confidence":0.8326,"contextual_strings_applied":3,"engine":"speech_analyzer","is_final":true,"language":"en_US","protocol_version":1,"segments":[{"confidence":0.8326,"end_seconds":3.5623125,"start_seconds":0,"text":"Plain song exports every new to obsidian before the stand-up."}],"text":"Plain song exports every new to obsidian before the stand-up.","type":"transcript"}"#;

    fn vocabulary_hint(terms: &[&str]) -> Option<crate::asr::VocabularyHint> {
        crate::asr::VocabularyHint::new(terms.iter().map(|term| term.to_string()).collect())
    }

    /// The hint the dictation route builds is already capped, but this route
    /// caps again: the helper is a separate binary, and a list that outgrew the
    /// cap should be trimmed on the way out rather than refused at the far end.
    #[test]
    fn vocabulary_terms_are_capped_the_way_the_whisper_prompt_is() {
        assert!(contextual_strings_for_helper(None).is_empty());

        let many: Vec<String> = (0..80).map(|index| format!("Term{index:02}")).collect();
        let many_hint = crate::asr::VocabularyHint::new(many).expect("terms");
        assert_eq!(
            contextual_strings_for_helper(Some(&many_hint)).len(),
            super::VOCABULARY_HINT_MAX_TERMS
        );

        // Twenty 50-character terms is 1000 characters, so the character cap
        // stops at twelve of them, well before the term cap.
        let long: Vec<String> = (0..20).map(|_| "x".repeat(50)).collect();
        let long_hint = crate::asr::VocabularyHint::new(long).expect("terms");
        let capped = contextual_strings_for_helper(Some(&long_hint));
        assert_eq!(capped.len(), 12);
        assert!(
            capped
                .iter()
                .map(|term| term.chars().count())
                .sum::<usize>()
                <= super::VOCABULARY_HINT_MAX_CHARS
        );

        // Whitespace is collapsed and anything that is not a term is dropped
        // rather than sent as an empty string the recognizer would ignore.
        let messy =
            vocabulary_hint(&["  ", "  Plain\tsong ", "Obsidian", "bad\u{7}term"]).expect("terms");
        assert_eq!(
            contextual_strings_for_helper(Some(&messy)),
            vec!["Plain song".to_string(), "Obsidian".to_string()]
        );
    }

    /// The count the app reports is the helper's own, so a helper too old to
    /// know the option reports nothing rather than the app assuming the terms
    /// arrived.
    #[test]
    fn the_applied_term_count_comes_from_the_helper_not_from_what_was_sent() {
        let older: HelperTranscriptPayload =
            parse_single_payload(HELPER_TRANSCRIPT_CAPTURE, "transcript")
                .expect("a helper capture without the field still parses");
        assert_eq!(older.contextual_strings_applied, 0);

        let sf: HelperTranscriptPayload =
            parse_single_payload(HELPER_HINTED_SF_CAPTURE, "transcript").expect("sf capture");
        assert_eq!(sf.contextual_strings_applied, 3);
        assert_eq!(sf.engine.as_deref(), Some("sf_speech_recognizer"));
        assert!(sf.text.contains("Plainsong"), "{}", sf.text);

        // The same three terms, the same fixture, the other engine: it took
        // them and its answer did not change. "Applied" means handed to the
        // recognizer, never that the recognizer acted on them, which is why
        // the receipt records the effect separately.
        let analyzer: HelperTranscriptPayload =
            parse_single_payload(HELPER_HINTED_ANALYZER_CAPTURE, "transcript")
                .expect("analyzer capture");
        assert_eq!(analyzer.contextual_strings_applied, 3);
        assert_eq!(analyzer.engine.as_deref(), Some("speech_analyzer"));
        assert!(analyzer.text.contains("Plain song"), "{}", analyzer.text);
    }

    /// The Models screen asks for a permission macOS named in the era when
    /// speech recognition meant sending audio to Apple. Neither engine does
    /// that here -- SpeechAnalyzer transcribes with the permission still
    /// undecided, and both run with server fallback off -- so the sentence
    /// that asks for the grant has to say what the grant is for. Plainsong
    /// keeps refusing until it is granted, in the app and in the helper: it is
    /// the only record of consent to on-device processing this route has.
    #[test]
    fn asking_for_speech_recognition_says_it_is_consent_not_a_server_grant() {
        let mut probe: HelperProbePayload = parse_single_payload(HELPER_PROBE_CAPTURE, "probe")
            .expect("the real helper probe should match the Rust contract");

        for (authorization, code) in [("not_determined", 0), ("denied", 1)] {
            probe.authorization = authorization.to_string();
            probe.authorization_code = code;
            let readiness = readiness_from_probe(&probe);
            assert!(!readiness.ready, "{authorization}");
            let action = readiness
                .setup_action
                .as_deref()
                .unwrap_or_else(|| panic!("{authorization} must offer a next action"));
            assert!(
                action.contains("consent to on-device processing"),
                "{authorization}: {action}"
            );
            assert!(
                action.contains("server fallback off"),
                "{authorization}: {action}"
            );
        }
    }

    /// The meeting gate decides the engine from one probe and the route used
    /// to decide again from another. Between the two, assets can be released
    /// or a reservation lost, and SFSpeechRecognizer returns no segments: a
    /// saved meeting with a full transcript, no timestamps, and no error.
    #[test]
    fn a_required_engine_refuses_anything_that_did_not_run_it() {
        let refusal = |required, reported: Option<&str>, segments| {
            engine_mismatch_refusal(required, reported, segments).map(|error| error.to_string())
        };

        // Dictation names no engine: either one is a correct answer.
        assert!(refusal(None, Some("sf_speech_recognizer"), 0).is_none());
        assert!(refusal(None, None, 0).is_none());

        // The contract holds: SpeechAnalyzer ran and returned timed segments.
        assert!(refusal(
            Some(AppleSpeechEngine::SpeechAnalyzer),
            Some("speech_analyzer"),
            3
        )
        .is_none());
        assert!(refusal(
            Some(AppleSpeechEngine::SfSpeechRecognizer),
            Some("sf_speech_recognizer"),
            0
        )
        .is_none());

        // A different engine ran than the one required.
        let swapped = refusal(
            Some(AppleSpeechEngine::SpeechAnalyzer),
            Some("sf_speech_recognizer"),
            0,
        )
        .expect("a swapped engine must be refused");
        assert!(swapped.contains("engine_mismatch"), "{swapped}");
        assert!(swapped.contains("SFSpeechRecognizer"), "{swapped}");
        assert!(swapped.contains("SpeechAnalyzer"), "{swapped}");

        // An older helper that reports no engine at all is not proof either.
        assert!(refusal(Some(AppleSpeechEngine::SpeechAnalyzer), None, 4).is_some());

        // The right engine, but nothing a meeting transcript can be built from.
        let untimed = refusal(
            Some(AppleSpeechEngine::SpeechAnalyzer),
            Some("speech_analyzer"),
            0,
        )
        .expect("a segment-less SpeechAnalyzer result must be refused");
        assert!(untimed.contains("no timed segments"), "{untimed}");
    }

    #[test]
    fn transcript_contract_carries_speech_analyzer_segments() {
        let payload: HelperTranscriptPayload =
            parse_single_payload(HELPER_TRANSCRIPT_CAPTURE, "transcript")
                .expect("the real helper transcript should match the Rust contract");
        assert!(payload.is_final);
        assert_eq!(payload.engine.as_deref(), Some("speech_analyzer"));
        assert_eq!(payload.segments.len(), 1);
        let segment = &payload.segments[0];
        assert_eq!(segment.start_seconds, 0.0);
        assert!((segment.end_seconds - 5.3226875).abs() < 1e-9);
        assert!(segment.confidence > 0.9);
        assert_eq!(segment.text, payload.text);
    }

    #[test]
    fn an_sf_speech_recognizer_transcript_still_parses_without_segments() {
        let json = br#"{"confidence":0.5,"is_final":true,"language":"en_US","protocol_version":1,"text":"hello there","type":"transcript"}"#;
        let payload: HelperTranscriptPayload = parse_single_payload(json, "transcript")
            .expect("a transcript without the new fields must still parse");
        assert!(payload.engine.is_none());
        assert!(payload.segments.is_empty());
    }

    #[test]
    fn speech_analyzer_live_events_fold_into_streaming_partials() {
        let lines = [
            r#"{"confidence":0,"end_seconds":4,"kind":"volatile","language":"en_US","protocol_version":1,"start_seconds":0,"text":"Plain song is a free and open source dictation app for the Mac.","type":"live"}"#,
            r#"{"confidence":0.9405384615384614,"end_seconds":3.36,"kind":"finalized","language":"en_US","protocol_version":1,"start_seconds":0,"text":"Plain song is a free and open source dictation app for the Mac.","type":"live"}"#,
            r#"{"confidence":0,"end_seconds":4,"kind":"volatile","language":"en_US","protocol_version":1,"start_seconds":3.36,"text":" It","type":"live"}"#,
            r#"{"confidence":0.9533999999999998,"end_seconds":10.14,"kind":"finalized","language":"en_US","protocol_version":1,"start_seconds":3.36,"text":" It listens when you press a hot, turns your words into text on your own machine, and types them into whatever app you are using.","type":"live"}"#,
        ];
        let events: Vec<SpeechAnalyzerLiveEvent> = lines
            .iter()
            .map(|line| {
                parse_speech_analyzer_live_line(line).expect("captured live line should parse")
            })
            .collect();

        let mut accumulator = SpeechAnalyzerPartialAccumulator::new();
        let partials: Vec<StreamingPartial> = events
            .iter()
            .map(|event| accumulator.apply(event))
            .collect();

        // A volatile span is the current guess and nothing is stable yet.
        assert_eq!(partials[0].stable_prefix, "");
        assert_eq!(
            partials[0].volatile_suffix,
            "Plain song is a free and open source dictation app for the Mac."
        );
        // Finalizing that span moves it into the stable prefix and clears the
        // guess, so nothing is shown twice.
        assert_eq!(
            partials[1].stable_prefix,
            "Plain song is a free and open source dictation app for the Mac."
        );
        assert_eq!(partials[1].volatile_suffix, "");
        // The next volatile span is appended to the display but not to the
        // stable text.
        assert_eq!(
            partials[2].stable_prefix,
            "Plain song is a free and open source dictation app for the Mac."
        );
        assert_eq!(partials[2].volatile_suffix, "It");
        assert_eq!(
            partials[2].combined_text(),
            "Plain song is a free and open source dictation app for the Mac. It"
        );
        // Two finalized spans join with exactly one space.
        assert_eq!(
            partials[3].stable_prefix,
            "Plain song is a free and open source dictation app for the Mac. It listens when you press a hot, turns your words into text on your own machine, and types them into whatever app you are using."
        );
        assert_eq!(partials[3].volatile_suffix, "");
        assert_eq!(accumulator.finalized_text(), partials[3].stable_prefix);
    }

    #[test]
    fn the_live_parser_ignores_every_other_helper_line() {
        // The closing `final` line keeps the SFSpeechRecognizer shape, so the
        // existing consumer still terminates on it rather than on a finalized
        // span.
        assert!(parse_speech_analyzer_live_line(r#"{"confidence":0.9341819823709108,"event":"final","is_final":true,"language":"en_US","protocol_version":1,"text":"Plain song is a free and open source dictation app for the Mac. It listens when you press a hot, turns your words into text on your own machine, and types them into whatever app you are using. Nothing you say ever leaves your computer. You can dictate an email in your male client, a message in Slack, a commit message in your terminal, or a note in your editor, and plain song will adapt its formatting to where you are typing. It also captures meetings without a bot joining the call, giving you transcripts, summaries, and action items you can search later. The goal is simple. Voice input everywhere, with no account, no subscription, and no cloud in the middle. This recording exists to benchmark transcription latency against realistic continuous speech instead of a synthetic tone.","type":"final"}"#).is_none());
        assert!(parse_speech_analyzer_live_line(
            r#"{"protocol_version":1,"type":"error","code":"cancelled","message":"stop","retryable":false,"details":{}}"#
        )
        .is_none());
        assert!(parse_speech_analyzer_live_line(
            r#"{"protocol_version":2,"type":"live","kind":"volatile","text":"x","language":"en_US"}"#
        )
        .is_none());
        assert!(parse_speech_analyzer_live_line(
            r#"{"protocol_version":1,"type":"live","kind":"speculative","text":"x","language":"en_US"}"#
        )
        .is_none());
        assert!(parse_speech_analyzer_live_line("").is_none());
    }

    /// The seam lane C1's streaming dictation plugs into.
    #[test]
    fn a_streaming_partial_sink_receives_every_partial() {
        #[derive(Default)]
        struct RecordingSink {
            partials: Vec<StreamingPartial>,
        }

        impl StreamingPartialSink for RecordingSink {
            fn accept_partial(&mut self, partial: StreamingPartial) {
                self.partials.push(partial);
            }
        }

        let mut accumulator = SpeechAnalyzerPartialAccumulator::new();
        let mut sink = RecordingSink::default();
        for line in [
            r#"{"confidence":0,"end_seconds":4,"kind":"volatile","language":"en_US","protocol_version":1,"start_seconds":0,"text":"Hello","type":"live"}"#,
            r#"{"confidence":0.9,"end_seconds":4,"kind":"finalized","language":"en_US","protocol_version":1,"start_seconds":0,"text":"Hello there.","type":"live"}"#,
        ] {
            let event = parse_speech_analyzer_live_line(line).expect("live line");
            sink.accept_partial(accumulator.apply(&event));
        }

        assert_eq!(sink.partials.len(), 2);
        assert_eq!(sink.partials[0].volatile_suffix, "Hello");
        assert_eq!(sink.partials[1].stable_prefix, "Hello there.");
        assert_eq!(sink.partials[1].volatile_suffix, "");
    }

    #[test]
    fn helper_authorization_payload_maps_known_statuses() {
        let payload = |authorization: &str, authorization_code| HelperProbePayload {
            protocol_version: HELPER_PROTOCOL_VERSION,
            kind: "probe".to_string(),
            authorization: authorization.to_string(),
            authorization_code,
            locale: "en_US".to_string(),
            locale_supported: true,
            on_device_available: true,
            recognizer_available: true,
            speech_analyzer_available: false,
            speech_analyzer_locale_supported: false,
            speech_analyzer_assets_installed: false,
            speech_analyzer_asset_status: String::new(),
            speech_analyzer_locales: Vec::new(),
            speech_analyzer_installed_locales: Vec::new(),
            operating_system_version: None,
        };
        assert_eq!(
            map_authorization_status_payload(&payload("authorized", 3)),
            SpeechAuthorizationStatus::Authorized
        );
        assert_eq!(
            map_authorization_status_payload(&payload("not_determined", 0)),
            SpeechAuthorizationStatus::NotDetermined
        );
        assert_eq!(
            map_authorization_status_payload(&payload("denied", 1)),
            SpeechAuthorizationStatus::Denied
        );
        assert_eq!(
            map_authorization_status_payload(&payload("restricted", 2)),
            SpeechAuthorizationStatus::Restricted
        );
        assert_eq!(
            map_authorization_status_payload(&payload("mystery", 99)),
            SpeechAuthorizationStatus::Unknown(99)
        );
    }

    #[test]
    fn readiness_requires_authorization_locale_and_on_device_capability() {
        let payload = |authorization: &str,
                       locale_supported: bool,
                       on_device_available: bool,
                       recognizer_available: bool| HelperProbePayload {
            protocol_version: HELPER_PROTOCOL_VERSION,
            kind: "probe".to_string(),
            authorization: authorization.to_string(),
            authorization_code: match authorization {
                "not_determined" => 0,
                "denied" => 1,
                "restricted" => 2,
                "authorized" => 3,
                _ => 99,
            },
            locale: "en_US".to_string(),
            locale_supported,
            on_device_available,
            recognizer_available,
            speech_analyzer_available: false,
            speech_analyzer_locale_supported: false,
            speech_analyzer_assets_installed: false,
            speech_analyzer_asset_status: String::new(),
            speech_analyzer_locales: Vec::new(),
            speech_analyzer_installed_locales: Vec::new(),
            operating_system_version: None,
        };

        for (probe, expected) in [
            (
                payload("not_determined", true, true, true),
                AppleSpeechReadinessStatus::AuthorizationNotDetermined,
            ),
            (
                payload("denied", true, true, true),
                AppleSpeechReadinessStatus::AuthorizationDenied,
            ),
            (
                payload("restricted", true, true, true),
                AppleSpeechReadinessStatus::AuthorizationRestricted,
            ),
            (
                payload("authorized", false, false, false),
                AppleSpeechReadinessStatus::UnsupportedLocale,
            ),
            (
                payload("authorized", true, false, true),
                AppleSpeechReadinessStatus::OnDeviceUnavailable,
            ),
            (
                payload("authorized", true, true, false),
                AppleSpeechReadinessStatus::RecognizerUnavailable,
            ),
            (
                payload("authorized", true, true, true),
                AppleSpeechReadinessStatus::Ready,
            ),
        ] {
            let readiness = readiness_from_probe(&probe);
            assert_eq!(readiness.status, expected);
            assert_eq!(
                readiness.ready,
                expected == AppleSpeechReadinessStatus::Ready
            );
            assert!(readiness.helper_present);
            assert!(readiness.platform_supported);
        }
    }

    #[test]
    fn rust_typed_errors_are_valid_helper_protocol_json() {
        let error = typed_error("helper_missing", "The required helper is missing.", false);
        let payload: HelperErrorPayload =
            serde_json::from_str(&error.to_string()).expect("typed error should be JSON");
        assert_eq!(payload.protocol_version, HELPER_PROTOCOL_VERSION);
        assert_eq!(payload.kind, "error");
        assert_eq!(payload.code, "helper_missing");
        assert!(!payload.retryable);
    }

    #[test]
    fn helper_contract_accepts_every_required_typed_error_code() {
        for code in [
            "helper_missing",
            "authorization_denied",
            "authorization_restricted",
            "authorization_not_determined",
            "unsupported_locale",
            "on_device_unavailable",
            "malformed_request",
            "timeout",
            "cancelled",
            "recognition_failed",
        ] {
            let line = format!(
                "{{\"protocol_version\":1,\"type\":\"error\",\"code\":\"{code}\",\"message\":\"failure\",\"retryable\":false,\"details\":{{}}}}"
            );
            let payload = parse_helper_error_line(&line).expect("valid typed helper error");
            assert_eq!(payload.code, code);
            assert_eq!(serialize_helper_error(&payload), line);
        }
    }

    #[test]
    fn probe_contract_reports_authorization_locale_and_on_device_capability() {
        let json = br#"{"authorization":"not_determined","authorization_code":0,"locale":"en_US","locale_supported":true,"on_device_available":true,"protocol_version":1,"recognizer_available":true,"type":"probe"}"#;
        let probe: HelperProbePayload =
            parse_single_payload(json, "probe").expect("probe should match Rust contract");
        assert_eq!(probe.authorization, "not_determined");
        assert!(probe.locale_supported);
        assert!(probe.on_device_available);
    }

    #[test]
    fn probe_contract_includes_speech_analyzer_fields_when_present() {
        let json = br#"{"authorization":"authorized","authorization_code":3,"locale":"en_US","locale_supported":true,"on_device_available":true,"protocol_version":1,"recognizer_available":true,"speech_analyzer_available":true,"operating_system_version":"26.0.0","type":"probe"}"#;
        let probe: HelperProbePayload =
            parse_single_payload(json, "probe").expect("probe should match Rust contract");
        assert!(probe.speech_analyzer_available);
        assert_eq!(probe.operating_system_version.as_deref(), Some("26.0.0"));
    }

    #[test]
    fn probe_contract_defaults_speech_analyzer_fields_when_absent() {
        let json = br#"{"authorization":"authorized","authorization_code":3,"locale":"en_US","locale_supported":true,"on_device_available":true,"protocol_version":1,"recognizer_available":true,"type":"probe"}"#;
        let probe: HelperProbePayload =
            parse_single_payload(json, "probe").expect("probe should match Rust contract");
        assert!(!probe.speech_analyzer_available);
        assert!(probe.operating_system_version.is_none());
    }

    /// The install is macOS' download, so the budget is generous -- but it is
    /// a budget. Before this the helper could sit forever holding a child
    /// process, the progress stream and the "Installing language…" button.
    #[test]
    fn a_language_install_gives_up_on_a_total_budget_and_on_silence() {
        // Downloading, slowly, but still talking: keep waiting.
        assert_eq!(
            install_wait_expiry(Duration::from_secs(15 * 60), Duration::from_secs(30)),
            None
        );
        // Still inside the total budget, but macOS has said nothing for longer
        // than a large download goes quiet.
        assert_eq!(
            install_wait_expiry(Duration::from_secs(5 * 60), INSTALL_PROGRESS_IDLE),
            Some(InstallWaitExpiry::NoProgress)
        );
        // Reporting progress the whole time, but past the outer bound.
        assert_eq!(
            install_wait_expiry(INSTALL_TOTAL_BUDGET, Duration::from_secs(1)),
            Some(InstallWaitExpiry::TotalBudget)
        );
        assert!(INSTALL_PROGRESS_IDLE < INSTALL_TOTAL_BUDGET);
        for expiry in [
            InstallWaitExpiry::NoProgress,
            InstallWaitExpiry::TotalBudget,
        ] {
            // The reader is looking at a spinner; the message has to say what
            // happened and what to do next.
            assert!(expiry.message().contains("System Settings"));
        }
    }

    /// A cancel that arrived while nothing was installing must not cancel the
    /// install the reader asks for next.
    #[test]
    fn a_stale_cancel_does_not_stop_the_next_install() {
        cancel_language_install();
        assert!(take_install_cancellation());
        assert!(!take_install_cancellation());
    }

    /// `child.wait()` is unbounded: a helper that ignored its stdin close, or
    /// wedged after closing stdout, kept the task alive for the life of the
    /// app. Proven against a stub child rather than the real helper, which
    /// cannot be pointed somewhere else on purpose.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn a_helper_that_will_not_exit_is_killed_rather_than_waited_on() {
        let mut child = TokioCommand::new("/bin/sleep")
            .arg("600")
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn a stub helper that never exits on its own");

        let started = Instant::now();
        let status = reap_helper_within(&mut child, Duration::from_millis(200)).await;

        assert!(
            status.is_some(),
            "a helper that will not exit must be killed and reaped"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the wait must be bounded, took {:?}",
            started.elapsed()
        );
    }

    /// The shape the install and live loops rely on: a helper that says
    /// nothing has to fall out of the read rather than parking the task.
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[tokio::test]
    async fn a_silent_helper_times_out_instead_of_blocking_the_reader() {
        let mut child = TokioCommand::new("/bin/sleep")
            .arg("600")
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn a stub helper that emits nothing");
        let stdout = child.stdout.take().expect("stub helper stdout");
        let mut lines = BufReader::new(stdout).lines();

        assert!(
            tokio::time::timeout(Duration::from_millis(200), lines.next_line())
                .await
                .is_err(),
            "a silent helper must expire the read rather than return"
        );

        let _ = child.kill().await;
        assert!(reap_helper_within(&mut child, Duration::from_secs(5))
            .await
            .is_some());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    fn packaged_test_paths() -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "nautilus-packaged-speech-helper-test-{}",
            uuid::Uuid::new_v4()
        ));
        let sidecar_dir = root
            .join("Plainsong.app")
            .join("Contents")
            .join("Resources")
            .join("sidecar");
        std::fs::create_dir_all(&sidecar_dir).expect("create fake packaged sidecar directory");
        let sidecar = sidecar_dir.join("plainsong-sidecar");
        std::fs::copy(
            std::env::current_exe().expect("resolve test executable"),
            &sidecar,
        )
        .expect("copy signed test executable into fake app");
        let mut sidecar_permissions = std::fs::metadata(&sidecar)
            .expect("inspect copied sidecar")
            .permissions();
        sidecar_permissions.set_mode(sidecar_permissions.mode() | 0o755);
        std::fs::set_permissions(&sidecar, sidecar_permissions)
            .expect("mark copied sidecar executable");
        let helper = sidecar_dir.join(HELPER_TARGET_NAME);
        (root, sidecar, helper)
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn packaged_resolution_does_not_fall_back_to_build_tree_helper() {
        let (root, sidecar, helper) = packaged_test_paths();
        assert!(!helper.exists());

        let error = resolve_helper_binary_path_for_executable(&sidecar)
            .expect_err("packaged lookup must fail when the bundle helper is absent");
        let payload: HelperErrorPayload =
            serde_json::from_str(&error.to_string()).expect("typed helper error");
        assert_eq!(payload.code, "helper_missing");

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn packaged_resolution_rejects_unsigned_helper_at_fixed_path() {
        use std::os::unix::fs::PermissionsExt;

        let (root, sidecar, helper) = packaged_test_paths();
        std::fs::write(&helper, b"#!/bin/sh\nprintf 'fake helper\\n'\n")
            .expect("write unsigned fake helper");
        let mut permissions = std::fs::metadata(&helper)
            .expect("inspect fake helper")
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(&helper, permissions).expect("mark fake helper executable");

        let error = resolve_helper_binary_path_for_executable(&sidecar)
            .expect_err("unsigned packaged helper must be rejected");
        let payload: HelperErrorPayload =
            serde_json::from_str(&error.to_string()).expect("typed helper trust error");
        assert_eq!(payload.code, "helper_untrusted");

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn packaged_resolution_accepts_signed_helper_at_fixed_path() {
        use std::os::unix::fs::PermissionsExt;

        let (root, sidecar, helper) = packaged_test_paths();
        let compiled_helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(HELPER_TARGET_NAME);
        std::fs::copy(compiled_helper, &helper).expect("copy compiled helper into fake app");
        let mut permissions = std::fs::metadata(&helper)
            .expect("inspect copied helper")
            .permissions();
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(&helper, permissions).expect("mark copied helper executable");

        assert_eq!(
            resolve_helper_binary_path_for_executable(&sidecar)
                .expect("signed helper at fixed packaged path should resolve"),
            helper
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn compiled_helper_probe_matches_rust_contract_without_requesting_permission() {
        use super::{resolve_helper_binary_path, run_helper_with_timeout};
        use std::ffi::OsString;
        use std::time::Duration;

        let helper = resolve_helper_binary_path().expect("required helper should exist");
        let output = run_helper_with_timeout(
            &helper,
            &[OsString::from("--probe")],
            Duration::from_secs(10),
        )
        .expect("probe should run");
        assert!(output.status.success());
        let probe: HelperProbePayload =
            parse_single_payload(&output.stdout, "probe").expect("probe contract should parse");
        assert!(!probe.locale.trim().is_empty());
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn compiled_helper_rejects_malformed_requests_with_typed_error() {
        use super::{resolve_helper_binary_path, run_helper_with_timeout};
        use std::ffi::OsString;
        use std::time::Duration;

        let helper = resolve_helper_binary_path().expect("required helper should exist");
        let output = run_helper_with_timeout(
            &helper,
            &[OsString::from("--not-a-command")],
            Duration::from_secs(10),
        )
        .expect("malformed request should return a process result");
        assert!(!output.status.success());
        let stdout = String::from_utf8(output.stdout).expect("helper output should be UTF-8");
        let payload = stdout
            .lines()
            .find_map(parse_helper_error_line)
            .expect("typed malformed request error");
        assert_eq!(payload.code, "malformed_request");
    }
}
