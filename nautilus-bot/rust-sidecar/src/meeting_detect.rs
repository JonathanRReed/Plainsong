//! Noticing a live call so Plainsong can offer to record it.
//!
//! Every few seconds the sidecar looks at which applications are running on
//! this Mac and asks two questions: is one of them a conferencing app, and is
//! there a second sign that a call is actually in progress? A running Zoom is
//! not a call — most people leave it open all day — so the app alone is never
//! enough. The second sign is either a window whose title says so (Zoom's
//! "Zoom Meeting", a browser tab titled for Google Meet) or the default input
//! device being open by some other process, which CoreAudio reports without
//! any permission.
//!
//! What it never does: start a recording. Detection ends in an offer — a
//! notification and an in-app cue — and the reader's click is what starts the
//! consent flow, the same one "New meeting" opens.
//!
//! The matcher and the debounced state machine are pure and tested; the macOS
//! sampler at the bottom is the only part that touches the OS.

use serde::Serialize;

/// The conferencing apps Plainsong knows how to recognize. Fixed list on
/// purpose: a heuristic that matches "anything using the microphone" would
/// fire for a voice memo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallApp {
    Zoom,
    MicrosoftTeams,
    Slack,
    Discord,
    FaceTime,
    Webex,
    GoogleMeet,
}

impl CallApp {
    pub fn label(self) -> &'static str {
        match self {
            Self::Zoom => "Zoom",
            Self::MicrosoftTeams => "Microsoft Teams",
            Self::Slack => "Slack",
            Self::Discord => "Discord",
            Self::FaceTime => "FaceTime",
            Self::Webex => "Webex",
            Self::GoogleMeet => "Google Meet",
        }
    }

    /// The `videoService` key the renderer's calendar prefill already uses,
    /// so a detected call and a calendar event carry the same tag.
    pub fn video_service(self) -> Option<&'static str> {
        match self {
            Self::Zoom => Some("zoom"),
            Self::MicrosoftTeams => Some("microsoft_teams"),
            Self::Webex => Some("webex"),
            Self::GoogleMeet => Some("google_meet"),
            Self::Slack | Self::Discord | Self::FaceTime => None,
        }
    }

    /// Order of preference when more than one app looks like a call at once.
    /// Slack and Discord sit last because they are the ones most often left
    /// running while a call happens somewhere else.
    fn priority(self) -> u8 {
        match self {
            Self::Zoom => 0,
            Self::MicrosoftTeams => 1,
            Self::GoogleMeet => 2,
            Self::Webex => 3,
            Self::FaceTime => 4,
            Self::Slack => 5,
            Self::Discord => 6,
        }
    }
}

/// The conferencing app a bundle identifier belongs to, if any.
pub fn call_app_for_bundle(bundle_id: &str) -> Option<CallApp> {
    match bundle_id {
        "us.zoom.xos" => Some(CallApp::Zoom),
        "com.microsoft.teams2" | "com.microsoft.teams" => Some(CallApp::MicrosoftTeams),
        "com.tinyspeck.slackmacgap" => Some(CallApp::Slack),
        "com.hnc.Discord" => Some(CallApp::Discord),
        "com.apple.FaceTime" => Some(CallApp::FaceTime),
        "Cisco-Systems.Spark" | "com.webex.meetingmanager" => Some(CallApp::Webex),
        _ => None,
    }
}

/// The browsers whose window titles are read for a Google Meet tab. Names are
/// for the log line only; matching is on the bundle id.
pub fn browser_for_bundle(bundle_id: &str) -> Option<&'static str> {
    match bundle_id {
        "com.google.Chrome" | "com.google.Chrome.beta" | "com.google.Chrome.canary" => {
            Some("Google Chrome")
        }
        "com.apple.Safari" | "com.apple.SafariTechnologyPreview" => Some("Safari"),
        "company.thebrowser.Browser" => Some("Arc"),
        "com.microsoft.edgemac" | "com.microsoft.edgemac.Beta" => Some("Microsoft Edge"),
        "org.mozilla.firefox" | "org.mozilla.firefoxdeveloperedition" => Some("Firefox"),
        _ => None,
    }
}

/// The dashes browsers and Google put between a title and what follows it.
const TITLE_SEPARATORS: [&str; 3] = ["-", "–", "—"];

/// Whether a browser window title has the shape of a Google Meet call.
///
/// Not the word "Meet" anywhere in the title — that matched "Meet the team —
/// Acme", so an open marketing tab announced a Google Meet call. What is
/// matched is the shapes Google's own pages actually produce: "Meet – code" or
/// "Meet - code" for a call, "Google Meet" for the lobby, and the same with a
/// browser's name appended ("Weekly sync - Meet - Google Chrome").
///
/// Case-sensitive on purpose — "meet.google.com" is a URL, not a title, and
/// lowercase "meet" in a page title is prose. Even so, a title is written by
/// whoever wrote the page, so it is never the only signal the browser path
/// asks for: see `candidate_for`.
pub fn title_mentions_meet(title: &str) -> bool {
    if title.contains("Google Meet") {
        return true;
    }
    TITLE_SEPARATORS.iter().any(|separator| {
        title.starts_with(&format!("Meet {separator} "))
            || title.contains(&format!(" {separator} Meet {separator} "))
            || title.ends_with(&format!(" {separator} Meet"))
    })
}

/// Whether a Zoom window title is the in-call window rather than the home
/// window or a settings sheet.
pub fn zoom_call_window_title(title: &str) -> bool {
    title.contains("Zoom Meeting") || title.contains("Zoom Webinar")
}

/// Whether this poll should read `bundle_id`'s window titles at all.
///
/// Zoom's are always worth reading: its in-call window title is the only thing
/// that separates a meeting from the home window, and Zoom is not left running
/// with an accessibility cost the way a browser is.
///
/// A browser's are not. Asking Chromium for `AXWindows` switches it into full
/// accessibility mode for the rest of its life — a standing CPU and memory
/// cost — so every five seconds forever is the wrong price for a signal that
/// only matters when something else already suggests a call. It is asked when
/// another process holds the microphone, or when that browser is where the
/// active call was found and the poll has to know whether its window is still
/// there.
pub fn should_read_window_titles(
    bundle_id: &str,
    mic_running_elsewhere: Option<bool>,
    active_call_bundle_id: Option<&str>,
) -> bool {
    if call_app_for_bundle(bundle_id) == Some(CallApp::Zoom) {
        return true;
    }
    if browser_for_bundle(bundle_id).is_none() {
        return false;
    }
    mic_running_elsewhere == Some(true) || active_call_bundle_id == Some(bundle_id)
}

/// One running application, as much of it as detection needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningApp {
    pub bundle_id: String,
    pub name: Option<String>,
    pub pid: i32,
    /// Window titles, read through Accessibility. Empty when Accessibility is
    /// not granted, when the app is not one whose titles matter, or when the
    /// app did not answer in time.
    pub window_titles: Vec<String>,
}

/// What one poll saw.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DetectorSample {
    pub apps: Vec<RunningApp>,
    /// Whether the default input device is open by some process other than
    /// Plainsong. `None` when Plainsong itself holds the microphone (a
    /// meeting, a dictation, the hands-free monitor): the signal then says
    /// nothing about anyone else, and must be treated as unknown rather than
    /// as either answer.
    pub mic_running_elsewhere: Option<bool>,
}

/// How sure detection is that this is a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallConfidence {
    /// One sign beyond the app running: a call window, or the microphone.
    Medium,
    /// Both signs at once.
    High,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallCandidate {
    pub app: CallApp,
    pub bundle_id: String,
    pub window_title: Option<String>,
    pub confidence: CallConfidence,
}

/// The call detection is currently sure about.
///
/// Serialized by hand rather than derived, because one field must not leave
/// the sidecar: see `window_title`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveCall {
    /// Monotonic per sidecar process. Dismissals are scoped to it, so waving
    /// away this call never silences the next one in the same app.
    pub call_id: u64,
    pub app: CallApp,
    pub app_label: &'static str,
    pub video_service: Option<&'static str>,
    pub bundle_id: String,
    /// The window title the call was found through, kept only so the next poll
    /// can tell whether that window is still there.
    ///
    /// It never crosses the wire. `meeting-call-detected` goes to every
    /// renderer window, and for Google Meet this title is the meeting's own
    /// name — read out of a browser, about a call Plainsong is not recording
    /// and may never be asked to record. Nothing in the UI wanted it;
    /// `hasCallWindow` is the part that was ever useful.
    pub window_title: Option<String>,
    pub confidence: CallConfidence,
    pub detected_at_ms: i64,
    pub detected_at: String,
    pub dismissed: bool,
}

/// `ActiveCall` as the renderer sees it: the window title replaced by whether
/// there was a window at all.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveCallWire<'a> {
    call_id: u64,
    app: CallApp,
    app_label: &'static str,
    video_service: Option<&'static str>,
    bundle_id: &'a str,
    /// Whether the call was found through a window rather than only through
    /// the microphone — which is what "this ends when the window closes"
    /// depends on.
    has_call_window: bool,
    confidence: CallConfidence,
    detected_at_ms: i64,
    detected_at: &'a str,
    dismissed: bool,
}

impl Serialize for ActiveCall {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ActiveCallWire {
            call_id: self.call_id,
            app: self.app,
            app_label: self.app_label,
            video_service: self.video_service,
            bundle_id: &self.bundle_id,
            has_call_window: self.window_title.is_some(),
            confidence: self.confidence,
            detected_at_ms: self.detected_at_ms,
            detected_at: &self.detected_at,
            dismissed: self.dismissed,
        }
        .serialize(serializer)
    }
}

impl ActiveCall {
    fn new(candidate: CallCandidate, call_id: u64, now_ms: i64) -> Self {
        Self {
            call_id,
            app: candidate.app,
            app_label: candidate.app.label(),
            video_service: candidate.app.video_service(),
            bundle_id: candidate.bundle_id,
            window_title: candidate.window_title,
            confidence: candidate.confidence,
            detected_at_ms: now_ms,
            detected_at: rfc3339(now_ms),
            dismissed: false,
        }
    }
}

fn rfc3339(unix_ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(unix_ms)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default()
}

/// Why a call stopped being detected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CallEndReason {
    /// The app is no longer running.
    AppQuit,
    /// The app is running but its call window is gone.
    WindowClosed,
    /// The app is running, no window was ever involved, and the microphone
    /// signal went away.
    SignalCleared,
    /// The user turned detection off.
    DetectionDisabled,
}

impl CallEndReason {
    /// Whether this end is evidence that the call itself is over, as opposed
    /// to evidence that detection stopped looking. Only these may end a
    /// recording.
    pub fn implies_call_over(self) -> bool {
        matches!(self, Self::AppQuit | Self::WindowClosed)
    }
}

fn candidate_for(
    app: &RunningApp,
    active: Option<&ActiveCall>,
    mic: Option<bool>,
) -> Option<CallCandidate> {
    let is_active_app = active.is_some_and(|call| call.bundle_id == app.bundle_id);
    let (kind, window_title) = if let Some(kind) = call_app_for_bundle(&app.bundle_id) {
        let window_title = match kind {
            CallApp::Zoom => app
                .window_titles
                .iter()
                .find(|title| zoom_call_window_title(title))
                .cloned(),
            _ => None,
        };
        (kind, window_title)
    } else if browser_for_bundle(&app.bundle_id).is_some() {
        // A page title is written by whoever wrote the page, so a tab that
        // looks like Meet is not on its own evidence of a call: the browser
        // path needs the microphone to be open by another process before it
        // will announce anything. Once a call IS the active one this drops
        // away — Plainsong recording it makes the microphone signal unknown,
        // and unknown is not "gone", so the title alone keeps it alive and
        // the window closing is still what ends it.
        if !is_active_app && mic != Some(true) {
            return None;
        }
        let title = app
            .window_titles
            .iter()
            .find(|title| title_mentions_meet(title))
            .cloned()?;
        (CallApp::GoogleMeet, Some(title))
    } else {
        return None;
    };

    let present = if is_active_app {
        // A call that was found through its window ends when the window
        // goes. One found through the microphone persists while the app runs
        // and nothing contradicts it: while Plainsong records, the mic signal
        // is unknown (it is Plainsong holding the device), and "unknown" is
        // not "gone".
        match active.and_then(|call| call.window_title.as_ref()) {
            Some(_) => window_title.is_some(),
            None => window_title.is_some() || mic != Some(false),
        }
    } else {
        window_title.is_some() || mic == Some(true)
    };
    if !present {
        return None;
    }

    let confidence = if window_title.is_some() && mic == Some(true) {
        CallConfidence::High
    } else {
        CallConfidence::Medium
    };
    Some(CallCandidate {
        app: kind,
        bundle_id: app.bundle_id.clone(),
        window_title,
        confidence,
    })
}

/// The single call this sample supports, or none. The active call's app wins
/// while it is still present; otherwise the highest-priority app.
pub fn select_candidate(
    sample: &DetectorSample,
    active: Option<&ActiveCall>,
) -> Option<CallCandidate> {
    let mut candidates: Vec<CallCandidate> = sample
        .apps
        .iter()
        .filter_map(|app| candidate_for(app, active, sample.mic_running_elsewhere))
        .collect();
    if let Some(active) = active {
        if let Some(index) = candidates
            .iter()
            .position(|candidate| candidate.bundle_id == active.bundle_id)
        {
            return Some(candidates.swap_remove(index));
        }
    }
    candidates.sort_by_key(|candidate| candidate.app.priority());
    candidates.into_iter().next()
}

/// Consecutive polls a candidate must be seen before it is announced.
pub const DETECTION_CONFIRMATIONS: u32 = 2;
/// Consecutive polls the active call must be missing before it is ended.
pub const END_CONFIRMATIONS: u32 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectorEvent {
    Detected(ActiveCall),
    Ended {
        call: ActiveCall,
        reason: CallEndReason,
    },
}

/// The debounced state machine over successive samples.
#[derive(Debug, Default)]
pub struct CallDetector {
    active: Option<ActiveCall>,
    /// A candidate seen but not yet confirmed: its bundle id and how many
    /// consecutive polls it has been seen for.
    pending: Option<(String, u32)>,
    /// Consecutive polls the active call has been missing for.
    misses: u32,
    next_call_id: u64,
    /// The most recently ended call and why, so a monitor that bound itself to
    /// a call id can learn how it ended even if it polls after the fact.
    last_ended: Option<(u64, CallEndReason)>,
}

impl CallDetector {
    pub fn active(&self) -> Option<&ActiveCall> {
        self.active.as_ref()
    }

    /// Why `call_id` ended, if it has.
    pub fn ended_reason(&self, call_id: u64) -> Option<CallEndReason> {
        self.last_ended
            .filter(|(ended_id, _)| *ended_id == call_id)
            .map(|(_, reason)| reason)
    }

    /// Feed one poll. Returns at most one event per poll.
    pub fn observe(&mut self, sample: &DetectorSample, now_ms: i64) -> Option<DetectorEvent> {
        let candidate = select_candidate(sample, self.active.as_ref());

        if let Some(active) = self.active.as_mut() {
            match candidate {
                Some(candidate) if candidate.bundle_id == active.bundle_id => {
                    self.misses = 0;
                    if candidate.window_title.is_some() {
                        active.window_title = candidate.window_title;
                    }
                    active.confidence = active.confidence.max(candidate.confidence);
                    None
                }
                other => {
                    self.misses += 1;
                    if self.misses < END_CONFIRMATIONS {
                        return None;
                    }
                    let app_running = sample
                        .apps
                        .iter()
                        .any(|app| app.bundle_id == active.bundle_id);
                    let reason = if !app_running {
                        CallEndReason::AppQuit
                    } else if active.window_title.is_some() {
                        CallEndReason::WindowClosed
                    } else {
                        CallEndReason::SignalCleared
                    };
                    let call = self.active.take().expect("active was just borrowed");
                    self.misses = 0;
                    self.last_ended = Some((call.call_id, reason));
                    // Whatever replaced it starts its own confirmation count.
                    self.pending = other.map(|candidate| (candidate.bundle_id, 1));
                    Some(DetectorEvent::Ended { call, reason })
                }
            }
        } else {
            let Some(candidate) = candidate else {
                self.pending = None;
                return None;
            };
            let seen = match self.pending.take() {
                Some((bundle_id, count)) if bundle_id == candidate.bundle_id => count + 1,
                _ => 1,
            };
            if seen < DETECTION_CONFIRMATIONS {
                self.pending = Some((candidate.bundle_id, seen));
                return None;
            }
            self.next_call_id += 1;
            let call = ActiveCall::new(candidate, self.next_call_id, now_ms);
            self.active = Some(call.clone());
            Some(DetectorEvent::Detected(call))
        }
    }

    /// Mark the active call dismissed. Returns whether `call_id` was the
    /// active call; a stale id (the call already ended) changes nothing.
    pub fn dismiss(&mut self, call_id: u64) -> bool {
        match self.active.as_mut() {
            Some(call) if call.call_id == call_id => {
                call.dismissed = true;
                true
            }
            _ => false,
        }
    }

    /// Forget the active call because detection was turned off. The returned
    /// call is reported as ended for that reason, which no auto-stop acts on.
    pub fn clear(&mut self) -> Option<ActiveCall> {
        self.pending = None;
        self.misses = 0;
        let call = self.active.take()?;
        self.last_ended = Some((call.call_id, CallEndReason::DetectionDisabled));
        Some(call)
    }
}

/// What `get_meeting_call_status` answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingCallStatus {
    /// Whether this build can detect calls at all (macOS only).
    pub supported: bool,
    /// The `meetings.callDetectionEnabled` setting.
    pub enabled: bool,
    /// Whether browser (Google Meet) and Zoom window titles can be read.
    pub accessibility_granted: bool,
    pub active_call: Option<ActiveCall>,
}

/// Whether a meeting bound to a detected call should end because that call
/// ended. Pure, so the monitor's policy is testable: the setting must be on,
/// the call must have ended, and the reason must say the call is over rather
/// than that detection stopped looking.
pub fn auto_stop_for_call_end(setting_enabled: bool, reason: Option<CallEndReason>) -> bool {
    setting_enabled && reason.is_some_and(CallEndReason::implies_call_over)
}

#[cfg(target_os = "macos")]
pub use macos::{default_input_device_running_somewhere, sample_running_apps};

#[cfg(target_os = "macos")]
mod macos {
    use super::{browser_for_bundle, call_app_for_bundle, RunningApp};
    use core_foundation::base::{CFRelease, TCFType};
    use core_foundation::string::CFString;
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex};
    use core_foundation_sys::base::{CFGetTypeID, CFTypeRef};
    use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};

    type AXUIElementRef = CFTypeRef;
    type AXError = i32;
    const AX_ERROR_SUCCESS: AXError = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout_seconds: f32)
            -> AXError;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> AXError;
    }

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectGetPropertyData(
            object_id: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier_data: *const std::ffi::c_void,
            data_size: *mut u32,
            data: *mut std::ffi::c_void,
        ) -> i32;
    }

    const K_AUDIO_OBJECT_SYSTEM_OBJECT: u32 = 1;
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = u32::from_be_bytes(*b"dIn ");
    const K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE: u32 = u32::from_be_bytes(*b"gone");

    /// How long an Accessibility query may wait on an app before it is given
    /// up. A frozen browser must cost the poll a quarter second, not the
    /// default six.
    const AX_MESSAGING_TIMEOUT_SECONDS: f32 = 0.25;

    fn read_u32_property(object_id: u32, selector: u32) -> Option<u32> {
        let address = AudioObjectPropertyAddress {
            selector,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut value as *mut u32).cast(),
            )
        };
        (status == 0).then_some(value)
    }

    /// Whether the default input device is open by any process. `None` when
    /// CoreAudio cannot answer (no input device at all, for instance).
    pub fn default_input_device_running_somewhere() -> Option<bool> {
        let device = read_u32_property(
            K_AUDIO_OBJECT_SYSTEM_OBJECT,
            K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
        )?;
        if device == 0 {
            return None;
        }
        read_u32_property(device, K_AUDIO_DEVICE_PROPERTY_DEVICE_IS_RUNNING_SOMEWHERE)
            .map(|running| running != 0)
    }

    fn ax_string(element: AXUIElementRef, attribute: &str) -> Option<String> {
        let attribute = CFString::new(attribute);
        let mut value: CFTypeRef = std::ptr::null();
        let error = unsafe {
            AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value)
        };
        if error != AX_ERROR_SUCCESS || value.is_null() {
            return None;
        }
        if unsafe { CFGetTypeID(value) } != unsafe { CFStringGetTypeID() } {
            unsafe { CFRelease(value) };
            return None;
        }
        Some(unsafe { CFString::wrap_under_create_rule(value as CFStringRef) }.to_string())
    }

    /// The titles of an app's windows, or nothing if the app does not answer.
    fn window_titles(pid: i32) -> Vec<String> {
        let app = unsafe { AXUIElementCreateApplication(pid) };
        if app.is_null() {
            return Vec::new();
        }
        unsafe { AXUIElementSetMessagingTimeout(app, AX_MESSAGING_TIMEOUT_SECONDS) };
        let attribute = CFString::new("AXWindows");
        let mut windows: CFTypeRef = std::ptr::null();
        let error = unsafe {
            AXUIElementCopyAttributeValue(app, attribute.as_concrete_TypeRef(), &mut windows)
        };
        let mut titles = Vec::new();
        if error == AX_ERROR_SUCCESS && !windows.is_null() {
            if unsafe { CFGetTypeID(windows) } == unsafe { CFArrayGetTypeID() } {
                let array = windows as core_foundation_sys::array::CFArrayRef;
                let count = unsafe { CFArrayGetCount(array) };
                for index in 0..count {
                    let window = unsafe { CFArrayGetValueAtIndex(array, index) } as AXUIElementRef;
                    if window.is_null() {
                        continue;
                    }
                    // The timeout set on the application element does not
                    // propagate to the window elements it hands back, so each
                    // of these reads ran at the 6 s default: an unresponsive
                    // browser with ten windows stalled the poll for a minute
                    // on a blocking thread. Every element that is messaged
                    // gets its own quarter second.
                    unsafe { AXUIElementSetMessagingTimeout(window, AX_MESSAGING_TIMEOUT_SECONDS) };
                    if let Some(title) = ax_string(window, "AXTitle") {
                        if !title.trim().is_empty() {
                            titles.push(title);
                        }
                    }
                }
            }
            unsafe { CFRelease(windows) };
        }
        unsafe { CFRelease(app) };
        titles
    }

    /// The running apps detection cares about. Only conferencing apps and the
    /// known browsers are returned; everything else on the machine is never
    /// looked at beyond its bundle id, and nothing is retained between polls.
    ///
    /// `mic_running_elsewhere` and `active_call_bundle_id` are this poll's
    /// reasons to touch Accessibility at all — see
    /// [`super::should_read_window_titles`].
    pub fn sample_running_apps(
        accessibility_granted: bool,
        mic_running_elsewhere: Option<bool>,
        active_call_bundle_id: Option<&str>,
    ) -> Vec<RunningApp> {
        use objc2_app_kit::NSWorkspace;

        let workspace = NSWorkspace::sharedWorkspace();
        let running = workspace.runningApplications();
        let mut apps = Vec::new();
        for app in running.iter() {
            let Some(bundle_id) = app.bundleIdentifier().map(|value| value.to_string()) else {
                continue;
            };
            let kind = call_app_for_bundle(&bundle_id);
            let is_browser = browser_for_bundle(&bundle_id).is_some();
            if kind.is_none() && !is_browser {
                continue;
            }
            let pid = app.processIdentifier();
            let wants_titles = super::should_read_window_titles(
                &bundle_id,
                mic_running_elsewhere,
                active_call_bundle_id,
            );
            let titles = if accessibility_granted && wants_titles && pid > 0 {
                window_titles(pid)
            } else {
                Vec::new()
            };
            apps.push(RunningApp {
                bundle_id,
                name: app.localizedName().map(|value| value.to_string()),
                pid,
                window_titles: titles,
            });
        }
        apps
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(bundle_id: &str, titles: &[&str]) -> RunningApp {
        RunningApp {
            bundle_id: bundle_id.to_string(),
            name: None,
            pid: 100,
            window_titles: titles.iter().map(|title| title.to_string()).collect(),
        }
    }

    fn sample(apps: Vec<RunningApp>, mic: Option<bool>) -> DetectorSample {
        DetectorSample {
            apps,
            mic_running_elsewhere: mic,
        }
    }

    #[test]
    fn bundle_ids_map_to_their_apps_and_labels() {
        assert_eq!(call_app_for_bundle("us.zoom.xos"), Some(CallApp::Zoom));
        assert_eq!(
            call_app_for_bundle("com.microsoft.teams2"),
            Some(CallApp::MicrosoftTeams)
        );
        assert_eq!(
            call_app_for_bundle("com.microsoft.teams"),
            Some(CallApp::MicrosoftTeams)
        );
        assert_eq!(
            call_app_for_bundle("com.tinyspeck.slackmacgap"),
            Some(CallApp::Slack)
        );
        assert_eq!(
            call_app_for_bundle("com.hnc.Discord"),
            Some(CallApp::Discord)
        );
        assert_eq!(
            call_app_for_bundle("com.apple.FaceTime"),
            Some(CallApp::FaceTime)
        );
        assert_eq!(
            call_app_for_bundle("Cisco-Systems.Spark"),
            Some(CallApp::Webex)
        );
        assert_eq!(
            call_app_for_bundle("com.webex.meetingmanager"),
            Some(CallApp::Webex)
        );
        assert_eq!(call_app_for_bundle("com.apple.Safari"), None);
        assert_eq!(call_app_for_bundle("com.plainsong.app"), None);
        assert_eq!(CallApp::MicrosoftTeams.label(), "Microsoft Teams");
        assert_eq!(CallApp::GoogleMeet.video_service(), Some("google_meet"));
        assert_eq!(CallApp::FaceTime.video_service(), None);
        assert_eq!(
            browser_for_bundle("company.thebrowser.Browser"),
            Some("Arc")
        );
        assert_eq!(browser_for_bundle("us.zoom.xos"), None);
    }

    #[test]
    fn browser_windows_are_only_read_when_something_already_suggests_a_call() {
        // Zoom always: its in-call window title is the whole signal, and it is
        // not a process that pays a standing cost for being asked.
        assert!(should_read_window_titles("us.zoom.xos", Some(false), None));
        assert!(should_read_window_titles("us.zoom.xos", None, None));

        // A browser only with a reason. Reading Chromium's windows every five
        // seconds forever is what flips it into full accessibility mode.
        assert!(!should_read_window_titles(
            "com.google.Chrome",
            Some(false),
            None
        ));
        assert!(!should_read_window_titles("com.google.Chrome", None, None));
        assert!(should_read_window_titles(
            "com.google.Chrome",
            Some(true),
            None
        ));
        // The browser the active call was found in stays readable, so the poll
        // can still see its window close while Plainsong holds the microphone.
        assert!(should_read_window_titles(
            "com.google.Chrome",
            None,
            Some("com.google.Chrome")
        ));
        assert!(!should_read_window_titles(
            "com.apple.Safari",
            None,
            Some("com.google.Chrome")
        ));

        // Everything else is never asked at all.
        assert!(!should_read_window_titles(
            "com.microsoft.teams2",
            Some(true),
            None
        ));
        assert!(!should_read_window_titles(
            "com.plainsong.app",
            Some(true),
            None
        ));
    }

    #[test]
    fn only_googles_own_meet_title_shapes_match() {
        // The shapes Google's pages and the browsers that host them produce.
        assert!(title_mentions_meet("Meet – abc-defg-hij"));
        assert!(title_mentions_meet("Meet - abc-defg-hij"));
        assert!(title_mentions_meet("Google Meet"));
        assert!(title_mentions_meet("Meet — Google Meet"));
        assert!(title_mentions_meet("Weekly sync - Meet - Google Chrome"));
        assert!(title_mentions_meet("Weekly sync – Meet – Arc"));
        assert!(title_mentions_meet("Weekly sync - Meet"));

        // The word "Meet" in prose is not a call. "Meet the team" is what made
        // an open marketing tab announce a Google Meet call after ten seconds.
        assert!(!title_mentions_meet("Meet the team — Acme"));
        assert!(!title_mentions_meet("Meet our engineers"));
        assert!(!title_mentions_meet("Come Meet us - Acme Corp"));
        assert!(!title_mentions_meet("Meeting notes - Google Docs"));
        assert!(!title_mentions_meet("meet.google.com"));
        assert!(!title_mentions_meet("Meetup Berlin"));
        assert!(!title_mentions_meet(""));

        assert!(zoom_call_window_title("Zoom Meeting"));
        assert!(zoom_call_window_title("Zoom Webinar - Q3 results"));
        assert!(!zoom_call_window_title("Zoom"));
        assert!(!zoom_call_window_title("Zoom Workplace Settings"));
    }

    #[test]
    fn a_browser_tab_alone_is_never_a_call() {
        // The mic is closed: a real Meet tab title is still not enough on its
        // own, because the title is written by whoever wrote the page.
        let idle = sample(
            vec![app("com.google.Chrome", &["Meet – abc-defg-hij"])],
            Some(false),
        );
        assert_eq!(select_candidate(&idle, None), None);
        // Unknown (Plainsong holds the device) is not evidence either.
        let unknown = sample(
            vec![app("com.google.Chrome", &["Meet – abc-defg-hij"])],
            None,
        );
        assert_eq!(select_candidate(&unknown, None), None);

        // With the microphone open elsewhere it is a call.
        let live = sample(
            vec![app("com.google.Chrome", &["Meet – abc-defg-hij"])],
            Some(true),
        );
        let candidate = select_candidate(&live, None).expect("meet tab plus microphone");
        assert_eq!(candidate.app, CallApp::GoogleMeet);
        assert_eq!(candidate.confidence, CallConfidence::High);
    }

    #[test]
    fn a_meet_call_being_recorded_survives_the_unknown_microphone() {
        // Plainsong recording the call makes the mic signal unknown; the tab is
        // still open, so the call must not end (and must not auto-stop the
        // meeting). Closing the tab still ends it.
        let mut detector = CallDetector::default();
        let live = sample(
            vec![app("com.google.Chrome", &["Meet – abc-defg-hij"])],
            Some(true),
        );
        let recording = sample(
            vec![app("com.google.Chrome", &["Meet – abc-defg-hij"])],
            None,
        );
        let tab_closed = sample(vec![app("com.google.Chrome", &["Inbox"])], None);
        detector.observe(&live, 1);
        detector.observe(&live, 2);
        assert!(detector.active().is_some());
        for now in 3..12 {
            assert_eq!(detector.observe(&recording, now), None);
        }
        assert!(detector.active().is_some());

        detector.observe(&tab_closed, 12);
        assert!(matches!(
            detector.observe(&tab_closed, 13),
            Some(DetectorEvent::Ended {
                reason: CallEndReason::WindowClosed,
                ..
            })
        ));
    }

    #[test]
    fn a_running_app_alone_is_never_a_call() {
        let zoom_idle = sample(vec![app("us.zoom.xos", &["Zoom"])], Some(false));
        assert_eq!(select_candidate(&zoom_idle, None), None);
        // Unknown mic (Plainsong holds it) is not evidence for a new call.
        let zoom_unknown = sample(vec![app("us.zoom.xos", &["Zoom"])], None);
        assert_eq!(select_candidate(&zoom_unknown, None), None);
    }

    #[test]
    fn a_second_signal_makes_a_candidate_and_both_signals_make_it_high() {
        let by_window = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(false));
        let candidate = select_candidate(&by_window, None).expect("window is evidence");
        assert_eq!(candidate.app, CallApp::Zoom);
        assert_eq!(candidate.window_title.as_deref(), Some("Zoom Meeting"));
        assert_eq!(candidate.confidence, CallConfidence::Medium);

        let by_mic = sample(vec![app("com.microsoft.teams2", &[])], Some(true));
        let candidate = select_candidate(&by_mic, None).expect("mic is evidence");
        assert_eq!(candidate.app, CallApp::MicrosoftTeams);
        assert_eq!(candidate.window_title, None);
        assert_eq!(candidate.confidence, CallConfidence::Medium);

        let both = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(true));
        assert_eq!(
            select_candidate(&both, None).expect("both").confidence,
            CallConfidence::High
        );
    }

    #[test]
    fn browser_meet_needs_a_meet_title_and_is_labelled_google_meet() {
        let docs = sample(
            vec![app("com.google.Chrome", &["Meeting notes - Google Docs"])],
            Some(true),
        );
        assert_eq!(select_candidate(&docs, None), None);

        let meet = sample(
            vec![app("com.apple.Safari", &["Inbox", "Meet – abc-defg-hij"])],
            Some(true),
        );
        let candidate = select_candidate(&meet, None).expect("meet tab");
        assert_eq!(candidate.app, CallApp::GoogleMeet);
        assert_eq!(candidate.bundle_id, "com.apple.Safari");
        assert_eq!(
            candidate.window_title.as_deref(),
            Some("Meet – abc-defg-hij")
        );
    }

    #[test]
    fn the_always_running_chat_apps_lose_to_a_real_call_app() {
        let everything = sample(
            vec![
                app("com.hnc.Discord", &[]),
                app("com.tinyspeck.slackmacgap", &[]),
                app("com.apple.FaceTime", &[]),
            ],
            Some(true),
        );
        assert_eq!(
            select_candidate(&everything, None).expect("one wins").app,
            CallApp::FaceTime
        );
    }

    #[test]
    fn detection_needs_two_consecutive_polls_and_the_same_app() {
        let mut detector = CallDetector::default();
        let zoom = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(false));
        let teams = sample(vec![app("com.microsoft.teams2", &[])], Some(true));
        let nothing = sample(vec![], Some(false));

        assert_eq!(detector.observe(&zoom, 1_000), None);
        // A different app in between resets the count.
        assert_eq!(detector.observe(&teams, 2_000), None);
        assert_eq!(detector.observe(&zoom, 3_000), None);
        // A miss resets it too.
        assert_eq!(detector.observe(&nothing, 4_000), None);
        assert_eq!(detector.observe(&zoom, 5_000), None);
        let event = detector
            .observe(&zoom, 6_000)
            .expect("second consecutive poll");
        let DetectorEvent::Detected(call) = event else {
            panic!("expected Detected, got {event:?}");
        };
        assert_eq!(call.call_id, 1);
        assert_eq!(call.app, CallApp::Zoom);
        assert_eq!(call.app_label, "Zoom");
        assert_eq!(call.video_service, Some("zoom"));
        assert_eq!(call.detected_at_ms, 6_000);
        assert_eq!(call.detected_at, "1970-01-01T00:00:06+00:00");
        assert!(!call.dismissed);
        assert_eq!(detector.active().map(|active| active.call_id), Some(1));
        // Steady state emits nothing more.
        assert_eq!(detector.observe(&zoom, 7_000), None);
    }

    #[test]
    fn ending_needs_two_consecutive_misses_and_names_the_reason() {
        let mut detector = CallDetector::default();
        let in_call = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(true));
        let window_closed = sample(vec![app("us.zoom.xos", &["Zoom"])], Some(false));
        let quit = sample(vec![], Some(false));
        detector.observe(&in_call, 1);
        detector.observe(&in_call, 2);
        assert!(detector.active().is_some());

        // One quiet poll is jitter.
        assert_eq!(detector.observe(&window_closed, 3), None);
        assert!(detector.active().is_some());
        // Recovery clears the miss count.
        assert_eq!(detector.observe(&in_call, 4), None);
        assert_eq!(detector.observe(&window_closed, 5), None);
        let event = detector
            .observe(&window_closed, 6)
            .expect("second miss ends it");
        assert_eq!(
            event,
            DetectorEvent::Ended {
                call: detector_call_fixture(),
                reason: CallEndReason::WindowClosed,
            }
        );
        assert_eq!(detector.active(), None);
        assert_eq!(detector.ended_reason(1), Some(CallEndReason::WindowClosed));
        assert_eq!(detector.ended_reason(2), None);

        // A mic-found call ends with AppQuit when the app is gone...
        let teams = sample(vec![app("com.microsoft.teams2", &[])], Some(true));
        detector.observe(&teams, 7);
        detector.observe(&teams, 8);
        detector.observe(&quit, 9);
        let event = detector.observe(&quit, 10).expect("quit");
        assert!(matches!(
            event,
            DetectorEvent::Ended {
                reason: CallEndReason::AppQuit,
                ..
            }
        ));
        assert_eq!(detector.ended_reason(2), Some(CallEndReason::AppQuit));

        // ...and with SignalCleared when it is still running but the mic closed.
        let teams_idle = sample(vec![app("com.microsoft.teams2", &[])], Some(false));
        detector.observe(&teams, 11);
        detector.observe(&teams, 12);
        detector.observe(&teams_idle, 13);
        let event = detector.observe(&teams_idle, 14).expect("signal cleared");
        assert!(matches!(
            event,
            DetectorEvent::Ended {
                reason: CallEndReason::SignalCleared,
                ..
            }
        ));
    }

    fn detector_call_fixture() -> ActiveCall {
        ActiveCall {
            call_id: 1,
            app: CallApp::Zoom,
            app_label: "Zoom",
            video_service: Some("zoom"),
            bundle_id: "us.zoom.xos".to_string(),
            window_title: Some("Zoom Meeting".to_string()),
            confidence: CallConfidence::High,
            detected_at_ms: 2,
            detected_at: rfc3339(2),
            dismissed: false,
        }
    }

    #[test]
    fn a_mic_found_call_survives_plainsong_taking_the_microphone() {
        // Detected through the mic, then Plainsong starts recording: the mic
        // signal becomes unknown. That must not end the call.
        let mut detector = CallDetector::default();
        let teams = sample(vec![app("com.microsoft.teams2", &[])], Some(true));
        let teams_unknown = sample(vec![app("com.microsoft.teams2", &[])], None);
        detector.observe(&teams, 1);
        detector.observe(&teams, 2);
        for now in 3..10 {
            assert_eq!(detector.observe(&teams_unknown, now), None);
        }
        assert!(detector.active().is_some());

        // And a window-found call still ends when its window goes, mic unknown.
        let mut detector = CallDetector::default();
        let zoom = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(false));
        let zoom_home_unknown = sample(vec![app("us.zoom.xos", &["Zoom"])], None);
        detector.observe(&zoom, 1);
        detector.observe(&zoom, 2);
        detector.observe(&zoom_home_unknown, 3);
        assert!(matches!(
            detector.observe(&zoom_home_unknown, 4),
            Some(DetectorEvent::Ended {
                reason: CallEndReason::WindowClosed,
                ..
            })
        ));
    }

    #[test]
    fn dismissal_is_scoped_to_one_call() {
        let mut detector = CallDetector::default();
        let zoom = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(true));
        let quiet = sample(vec![], Some(false));
        detector.observe(&zoom, 1);
        detector.observe(&zoom, 2);
        assert!(!detector.dismiss(99));
        assert!(detector.dismiss(1));
        assert!(detector.active().is_some_and(|call| call.dismissed));
        // Stays dismissed while this call lasts.
        detector.observe(&zoom, 3);
        assert!(detector.active().is_some_and(|call| call.dismissed));

        detector.observe(&quiet, 4);
        detector.observe(&quiet, 5);
        assert_eq!(detector.active(), None);
        // The next call in the same app is a new call, not dismissed.
        detector.observe(&zoom, 6);
        let event = detector.observe(&zoom, 7).expect("new call");
        let DetectorEvent::Detected(call) = event else {
            panic!("expected Detected");
        };
        assert_eq!(call.call_id, 2);
        assert!(!call.dismissed);
        // A dismissal aimed at the old call does nothing to the new one.
        assert!(!detector.dismiss(1));
        assert!(!detector.active().expect("active").dismissed);
    }

    #[test]
    fn clearing_for_a_disabled_setting_is_not_a_call_over() {
        let mut detector = CallDetector::default();
        assert_eq!(detector.clear(), None);
        let zoom = sample(vec![app("us.zoom.xos", &["Zoom Meeting"])], Some(true));
        detector.observe(&zoom, 1);
        detector.observe(&zoom, 2);
        let cleared = detector.clear().expect("active call cleared");
        assert_eq!(cleared.call_id, 1);
        assert_eq!(detector.active(), None);
        assert_eq!(
            detector.ended_reason(1),
            Some(CallEndReason::DetectionDisabled)
        );
        assert!(!auto_stop_for_call_end(true, detector.ended_reason(1)));
    }

    #[test]
    fn auto_stop_only_for_reasons_that_mean_the_call_is_over() {
        assert!(auto_stop_for_call_end(true, Some(CallEndReason::AppQuit)));
        assert!(auto_stop_for_call_end(
            true,
            Some(CallEndReason::WindowClosed)
        ));
        assert!(!auto_stop_for_call_end(
            true,
            Some(CallEndReason::SignalCleared)
        ));
        assert!(!auto_stop_for_call_end(
            true,
            Some(CallEndReason::DetectionDisabled)
        ));
        assert!(!auto_stop_for_call_end(true, None));
        assert!(!auto_stop_for_call_end(false, Some(CallEndReason::AppQuit)));
    }

    #[test]
    fn active_call_serializes_camel_case_and_never_the_window_title() {
        let json = serde_json::to_value(detector_call_fixture()).expect("serialize");
        assert_eq!(json["callId"], 1);
        assert_eq!(json["app"], "zoom");
        assert_eq!(json["appLabel"], "Zoom");
        assert_eq!(json["videoService"], "zoom");
        assert_eq!(json["bundleId"], "us.zoom.xos");
        assert_eq!(json["confidence"], "high");
        assert_eq!(json["detectedAtMs"], 2);
        assert_eq!(json["dismissed"], false);

        // The title itself never crosses the wire: for Meet it is the
        // meeting's name, broadcast to every renderer window about a call
        // Plainsong is not recording. Only its presence travels.
        assert_eq!(json["hasCallWindow"], true);
        assert!(
            json.get("windowTitle").is_none(),
            "the window title must not be serialized: {json}"
        );
        assert!(
            !serde_json::to_string(&detector_call_fixture())
                .expect("serialize")
                .contains("Zoom Meeting"),
            "no serialized form may carry the title"
        );

        let mic_only = ActiveCall {
            window_title: None,
            ..detector_call_fixture()
        };
        assert_eq!(
            serde_json::to_value(mic_only).expect("serialize")["hasCallWindow"],
            false
        );
    }
}
