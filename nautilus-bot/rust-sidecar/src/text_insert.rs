//! Putting dictated text where the cursor is.
//!
//! The macOS Accessibility (AX) bridge, the clipboard, the synthetic Cmd+V /
//! Cmd+C / Cmd+Z keystrokes, the secure-field probe that refuses to deliver
//! into a password box, and the permission checks that gate all of it. The
//! non-macOS arms are here too, so the platform split stays in one place.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

#[expect(
    dead_code,
    reason = "paste strategy metadata is retained for insertion diagnostics and QA evidence"
)]
pub(crate) struct PasteOutcome {
    pub(crate) pasted: bool,
    pub(crate) copied: bool,
    pub(crate) direct_accessibility: bool,
    /// Whether the target was actually observed to receive the text, as
    /// opposed to the keystroke merely having been dispatched. Direct
    /// Accessibility writes are confirmed: the API reports whether the value
    /// was set. A native Cmd+V is NOT — `CGEvent::post` returns nothing, so a
    /// target that ignored, blocked, or was too slow to accept the paste is
    /// indistinguishable from one that took it. Reporting that case as a plain
    /// success is what made the app claim it had inserted text it had not.
    pub(crate) confirmed: bool,
    pub(crate) successful_strategy: Option<CursorInsertStrategy>,
    pub(crate) error: Option<String>,
    /// `Some` when delivery was refused because the focused control is a
    /// password or other secure input. Nothing was inserted and nothing was
    /// staged on the clipboard; `error` carries the plain-language reason
    /// and the stop path reports `outcome = "secure_field"`.
    pub(crate) secure_field: Option<dictation_secure_field::SecureFieldSignal>,
}

#[cfg(target_os = "macos")]
pub(crate) type AXUIElementRef = CFTypeRef;

#[cfg(target_os = "macos")]
pub(crate) type AXError = i32;

#[cfg(target_os = "macos")]
pub(crate) const AX_ERROR_SUCCESS: AXError = 0;
#[cfg(target_os = "macos")]
pub(crate) const AX_ERROR_CANNOT_COMPLETE: AXError = -25204;
#[cfg(target_os = "macos")]
pub(crate) const AX_ERROR_ATTRIBUTE_UNSUPPORTED: AXError = -25205;
#[cfg(target_os = "macos")]
pub(crate) const AX_ERROR_NO_VALUE: AXError = -25212;
#[cfg(target_os = "macos")]
pub(crate) const AX_VALUE_CG_POINT_TYPE: u32 = 1;
#[cfg(target_os = "macos")]
pub(crate) const AX_VALUE_CG_SIZE_TYPE: u32 = 2;
#[cfg(target_os = "macos")]
pub(crate) const AX_VALUE_CF_RANGE_TYPE: u32 = 4;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
}

// HIToolbox (Carbon umbrella). Secure event input is the OS-level switch a
// password field turns on while it has focus; Terminal's "Secure Keyboard
// Entry" and password managers hold it on deliberately. Reading it needs no
// Accessibility permission, which is exactly why it is the backstop when the
// focused element cannot be inspected.
#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> Boolean;
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut Boolean,
    ) -> AXError;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    fn AXValueCreate(the_type: u32, value_ptr: *const std::ffi::c_void) -> CFTypeRef;
    fn AXValueGetType(value: CFTypeRef) -> u32;
    fn AXValueGetValue(
        value: CFTypeRef,
        the_type: u32,
        value_ptr: *mut std::ffi::c_void,
    ) -> Boolean;
}

#[cfg(target_os = "macos")]
pub(crate) fn check_accessibility_permission() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

#[cfg(target_os = "macos")]
pub(crate) fn request_accessibility_permission() -> bool {
    let prompt_key = CFString::new("AXTrustedCheckOptionPrompt");
    let prompt_value = CFBoolean::true_value();
    let options = CFDictionary::from_CFType_pairs(&[(prompt_key, prompt_value)]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0 }
}

#[cfg(target_os = "macos")]
pub(crate) fn reset_tcc_service(service: &str, bundle_id: &str) -> Result<(), String> {
    let output = std::process::Command::new("/usr/bin/tccutil")
        .args(["reset", service, bundle_id])
        .output()
        .map_err(|error| format!("Failed to launch tccutil: {}", error))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "tccutil reset {} {} exited with status {}",
            service, bundle_id, output.status
        ))
    } else {
        Err(stderr)
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn check_microphone_permission() -> bool {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let status = unsafe {
        AVCaptureDevice::authorizationStatusForMediaType(
            AVMediaTypeAudio.as_ref().expect("audio media type"),
        )
    };
    status == AVAuthorizationStatus::Authorized
}

#[cfg(target_os = "macos")]
pub(crate) fn request_microphone_permission() -> Result<bool, String> {
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    let state = Arc::new((StdMutex::new(None::<bool>), Condvar::new()));
    let state_clone = Arc::clone(&state);
    let block = RcBlock::new(move |granted: Bool| {
        let (lock, condvar) = &*state_clone;
        if let Ok(mut guard) = lock.lock() {
            *guard = Some(granted.as_bool());
            condvar.notify_one();
        }
    });

    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(
            AVMediaTypeAudio.as_ref().expect("audio media type"),
            &block,
        );
    }

    let (lock, condvar) = &*state;
    let guard = lock
        .lock()
        .map_err(|_| "Failed to acquire microphone authorization lock".to_string())?;
    let (mut guard, wait_result) = condvar
        .wait_timeout_while(guard, Duration::from_secs(20), |current| current.is_none())
        .map_err(|_| "Failed while waiting for microphone authorization".to_string())?;

    if wait_result.timed_out() {
        return Err("Timed out waiting for microphone authorization response.".to_string());
    }

    guard
        .take()
        .ok_or_else(|| "Microphone authorization callback returned no status.".to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_microphone_permission(prompt_if_needed: bool) -> Result<(), String> {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    let status = unsafe {
        AVCaptureDevice::authorizationStatusForMediaType(
            AVMediaTypeAudio.as_ref().expect("audio media type"),
        )
    };

    if status == AVAuthorizationStatus::Authorized {
        return Ok(());
    }

    if status == AVAuthorizationStatus::Denied {
        return Err(
            "Microphone permission denied. Enable Plainsong in Privacy & Security > Microphone."
                .to_string(),
        );
    }

    if status == AVAuthorizationStatus::Restricted {
        return Err("Microphone permission is restricted by system policy.".to_string());
    }

    if status != AVAuthorizationStatus::NotDetermined {
        return Err(format!(
            "Unexpected microphone authorization status: {}",
            status.0
        ));
    }

    if !prompt_if_needed {
        return Err(
            "Microphone permission has not been granted yet. Enable auto-request permissions or allow Plainsong in Privacy & Security > Microphone."
                .to_string(),
        );
    }

    match request_microphone_permission() {
        Ok(true) => Ok(()),
        Ok(false) => Err(
            "Microphone permission was not granted. Enable Plainsong in Privacy & Security > Microphone."
                .to_string(),
        ),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn check_post_event_access() -> bool {
    unsafe { CGPreflightPostEventAccess() }
}

#[cfg(target_os = "macos")]
pub(crate) fn request_post_event_access() -> bool {
    unsafe { CGRequestPostEventAccess() }
}

#[cfg(target_os = "macos")]
pub(crate) fn can_dispatch_hotkeys() -> bool {
    check_accessibility_permission() || check_post_event_access()
}

#[cfg(target_os = "macos")]
pub(crate) fn current_app_bundle_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let macos_dir = executable.parent()?;
    if macos_dir.file_name()?.to_str()? != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let bundle_dir = contents_dir.parent()?;
    if bundle_dir.extension()?.to_str()? != "app" {
        return None;
    }
    Some(bundle_dir.to_path_buf())
}

#[cfg(target_os = "macos")]
pub(crate) fn installed_nautilus_app_bundle_path() -> Option<PathBuf> {
    let path = PathBuf::from("/Applications/Plainsong.app");
    path.exists().then_some(path)
}

/// Whether an insertion target is Plainsong itself. Used by the macOS
/// reactivation path (never bring ourselves forward) and by post-insert
/// correction capture (a result edited in Plainsong's own box is the in-app
/// learning path's business, not the other-apps readback's).
pub(crate) fn is_self_activation_target(
    app_name: Option<&str>,
    app_bundle_id: Option<&str>,
) -> bool {
    let name_matches = app_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value.eq_ignore_ascii_case("Plainsong") || value.eq_ignore_ascii_case("nautilus-bot")
        })
        .unwrap_or(false);
    let bundle_matches = app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value == APP_BUNDLE_IDENTIFIER)
        .unwrap_or(false);
    name_matches || bundle_matches
}

#[cfg(target_os = "macos")]
pub(crate) fn is_transient_activation_target(
    app_name: Option<&str>,
    app_bundle_id: Option<&str>,
) -> bool {
    let name_matches = app_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "usernotificationcenter" | "notificationcenter" | "controlcenter" | "dock"
            )
        })
        .unwrap_or(false);
    let bundle_matches = app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            matches!(
                value,
                "com.apple.usernotificationcenter"
                    | "com.apple.notificationcenterui"
                    | "com.apple.controlcenter"
                    | "com.apple.dock"
            )
        })
        .unwrap_or(false);
    name_matches || bundle_matches
}

#[cfg(target_os = "macos")]
pub(crate) fn sanitize_dictation_target(
    app_name: Option<String>,
    app_bundle_id: Option<String>,
) -> (Option<String>, Option<String>) {
    if is_self_activation_target(app_name.as_deref(), app_bundle_id.as_deref())
        || is_transient_activation_target(app_name.as_deref(), app_bundle_id.as_deref())
    {
        (None, None)
    } else {
        (app_name, app_bundle_id)
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn is_running_from_disk_image() -> bool {
    current_app_bundle_path()
        .map(|path| path.starts_with("/Volumes/"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_error_description(error: AXError) -> &'static str {
    match error {
        AX_ERROR_SUCCESS => "success",
        -25200 => "generic failure",
        -25201 => "illegal argument",
        -25202 => "invalid ui element",
        -25203 => "invalid observer",
        -25204 => "could not complete",
        AX_ERROR_ATTRIBUTE_UNSUPPORTED => "attribute unsupported",
        -25206 => "action unsupported",
        -25208 => "not implemented",
        -25211 => "accessibility api disabled",
        AX_ERROR_NO_VALUE => "no value",
        -25213 => "parameterized attribute unsupported",
        _ => "unknown accessibility error",
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_attribute(name: &str) -> CFString {
    CFString::new(name)
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_copy_attribute_value(
    element: AXUIElementRef,
    attribute: &str,
) -> Result<Option<CFTypeRef>, String> {
    let attribute_name = ax_attribute(attribute);
    let mut value: CFTypeRef = std::ptr::null();
    let error = unsafe {
        AXUIElementCopyAttributeValue(
            element,
            attribute_name.as_concrete_TypeRef(),
            &mut value as *mut CFTypeRef,
        )
    };

    if error == AX_ERROR_SUCCESS {
        if value.is_null() {
            Ok(None)
        } else {
            Ok(Some(value))
        }
    } else if matches!(error, AX_ERROR_ATTRIBUTE_UNSUPPORTED | AX_ERROR_NO_VALUE) {
        Ok(None)
    } else {
        Err(format!(
            "Accessibility attribute '{}' failed ({}, AXError {}).",
            attribute,
            ax_error_description(error),
            error
        ))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_is_attribute_settable(
    element: AXUIElementRef,
    attribute: &str,
) -> Result<bool, String> {
    let attribute_name = ax_attribute(attribute);
    let mut settable: Boolean = 0;
    let error = unsafe {
        AXUIElementIsAttributeSettable(
            element,
            attribute_name.as_concrete_TypeRef(),
            &mut settable as *mut Boolean,
        )
    };

    if error == AX_ERROR_SUCCESS {
        Ok(settable != 0)
    } else if matches!(error, AX_ERROR_ATTRIBUTE_UNSUPPORTED | AX_ERROR_NO_VALUE) {
        Ok(false)
    } else {
        Err(format!(
            "Accessibility settable check for '{}' failed ({}, AXError {}).",
            attribute,
            ax_error_description(error),
            error
        ))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_copy_string_attribute(
    element: AXUIElementRef,
    attribute: &str,
) -> Result<Option<String>, String> {
    let Some(value) = ax_copy_attribute_value(element, attribute)? else {
        return Ok(None);
    };

    let type_id = unsafe { CFGetTypeID(value) };
    if type_id != unsafe { CFStringGetTypeID() } {
        unsafe { CFRelease(value) };
        return Ok(None);
    }

    let string = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) }.to_string();
    Ok(Some(string))
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_copy_cf_range_attribute(
    element: AXUIElementRef,
    attribute: &str,
) -> Result<Option<CFRange>, String> {
    let Some(value) = ax_copy_attribute_value(element, attribute)? else {
        return Ok(None);
    };

    let value_type = unsafe { AXValueGetType(value) };
    if value_type != AX_VALUE_CF_RANGE_TYPE {
        unsafe { CFRelease(value) };
        return Ok(None);
    }

    let mut range = CFRange {
        location: 0,
        length: 0,
    };
    let copied = unsafe {
        AXValueGetValue(
            value,
            AX_VALUE_CF_RANGE_TYPE,
            &mut range as *mut CFRange as *mut std::ffi::c_void,
        ) != 0
    };
    unsafe { CFRelease(value) };

    if copied {
        Ok(Some(range))
    } else {
        Err(format!(
            "Accessibility range decode for '{}' failed.",
            attribute
        ))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_set_string_attribute(
    element: AXUIElementRef,
    attribute: &str,
    value: &str,
) -> Result<(), String> {
    let attribute_name = ax_attribute(attribute);
    let value_string = CFString::new(value);
    let error = unsafe {
        AXUIElementSetAttributeValue(
            element,
            attribute_name.as_concrete_TypeRef(),
            value_string.as_concrete_TypeRef() as CFTypeRef,
        )
    };

    if error == AX_ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "Accessibility set for '{}' failed ({}, AXError {}).",
            attribute,
            ax_error_description(error),
            error
        ))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn ax_set_cf_range_attribute(
    element: AXUIElementRef,
    attribute: &str,
    value: CFRange,
) -> Result<(), String> {
    let attribute_name = ax_attribute(attribute);
    let ax_value = unsafe {
        AXValueCreate(
            AX_VALUE_CF_RANGE_TYPE,
            &value as *const CFRange as *const std::ffi::c_void,
        )
    };
    if ax_value.is_null() {
        return Err(format!(
            "Accessibility range wrapper creation for '{}' failed.",
            attribute
        ));
    }

    let error = unsafe {
        AXUIElementSetAttributeValue(element, attribute_name.as_concrete_TypeRef(), ax_value)
    };
    unsafe { CFRelease(ax_value) };

    if error == AX_ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!(
            "Accessibility set for '{}' failed ({}, AXError {}).",
            attribute,
            ax_error_description(error),
            error
        ))
    }
}

#[cfg(any(test, target_os = "macos"))]
pub(crate) fn replace_utf16_range(
    value: &str,
    range: CFRange,
    replacement: &str,
) -> Option<(String, CFRange)> {
    if range.location < 0 || range.length < 0 {
        return None;
    }

    let start = usize::try_from(range.location).ok()?;
    let length = usize::try_from(range.length).ok()?;
    let end = start.checked_add(length)?;

    let mut utf16_value = value.encode_utf16().collect::<Vec<_>>();
    if end > utf16_value.len() {
        return None;
    }

    let replacement_utf16 = replacement.encode_utf16().collect::<Vec<_>>();
    let caret_location = start.checked_add(replacement_utf16.len())?;
    utf16_value.splice(start..end, replacement_utf16.iter().copied());
    let next_value = String::from_utf16(&utf16_value).ok()?;
    let next_range = CFRange {
        location: isize::try_from(caret_location).ok()?,
        length: 0,
    };
    Some((next_value, next_range))
}

/// Whether macOS currently has secure event input on. System-wide: true
/// while any password field has focus, and while an app that opts in
/// (Terminal's Secure Keyboard Entry, password managers) keeps it on.
#[cfg(target_os = "macos")]
pub(crate) fn secure_event_input_enabled() -> bool {
    unsafe { IsSecureEventInputEnabled() != 0 }
}

/// Decides whether `focused_element` may receive dictated text. Reads the
/// role and subrole the element reports and combines them with the
/// secure-event-input flag through the pure policy in
/// `dictation_secure_field`.
#[cfg(target_os = "macos")]
pub(crate) fn classify_focused_element_security(
    focused_element: AXUIElementRef,
) -> Option<dictation_secure_field::SecureFieldSignal> {
    let role = ax_copy_string_attribute(focused_element, "AXRole")
        .ok()
        .flatten();
    let subrole = ax_copy_string_attribute(focused_element, "AXSubrole")
        .ok()
        .flatten();
    dictation_secure_field::classify_secure_field(
        role.as_deref(),
        subrole.as_deref(),
        secure_event_input_enabled(),
    )
}

/// Probes the system-wide focused element for the secure-field policy
/// without needing a caller-held element. Used before the clipboard-paste
/// fallback and before the synthetic Cmd+C of selection capture — the paths
/// that do not otherwise look at the focused control at all. When the
/// element cannot be reached (no Accessibility permission, no reported
/// focus) the secure-event-input flag alone decides.
#[cfg(target_os = "macos")]
pub(crate) fn probe_focused_secure_field() -> Option<dictation_secure_field::SecureFieldSignal> {
    let secure_event_input = secure_event_input_enabled();
    let system_wide = unsafe { AXUIElementCreateSystemWide() };
    if system_wide.is_null() {
        return dictation_secure_field::classify_secure_field(None, None, secure_event_input);
    }
    let focused_element = ax_copy_attribute_value(system_wide, "AXFocusedUIElement")
        .ok()
        .flatten();
    unsafe { CFRelease(system_wide) };
    let Some(focused_element) = focused_element else {
        return dictation_secure_field::classify_secure_field(None, None, secure_event_input);
    };
    let signal = classify_focused_element_security(focused_element);
    unsafe { CFRelease(focused_element) };
    signal
}

/// Why a direct Accessibility write did not happen.
#[cfg(target_os = "macos")]
pub(crate) enum AccessibilityInsertFailure {
    /// The focused control is a password or other secure input. Delivery
    /// stops here: no paste fallback, no clipboard staging.
    SecureField(dictation_secure_field::SecureFieldSignal),
    /// Any other reason; the caller may fall back to a native paste.
    Other(String),
}

#[cfg(target_os = "macos")]
impl From<String> for AccessibilityInsertFailure {
    fn from(message: String) -> Self {
        AccessibilityInsertFailure::Other(message)
    }
}

/// The `PasteOutcome` for a delivery refused by the secure-field policy:
/// nothing inserted, nothing on the clipboard, the reason spelled out.
/// The secure-field probe for clipboard-only delivery, on every platform:
/// macOS inspects the focused control; other platforms have no probe yet
/// and never refuse.
pub(crate) fn probe_clipboard_delivery_secure_field(
) -> Option<dictation_secure_field::SecureFieldSignal> {
    #[cfg(target_os = "macos")]
    {
        probe_focused_secure_field()
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

pub(crate) fn secure_field_refusal_outcome(
    signal: dictation_secure_field::SecureFieldSignal,
) -> PasteOutcome {
    tracing::warn!(
        "Refusing dictation delivery: {}. Nothing was inserted or copied; the text stays in dictation history.",
        signal.describe()
    );
    PasteOutcome {
        pasted: false,
        copied: false,
        direct_accessibility: false,
        confirmed: false,
        successful_strategy: None,
        error: Some(dictation_secure_field::secure_field_refusal_message(signal)),
        secure_field: Some(signal),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn insert_text_via_accessibility_guarded(
    text: &str,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), AccessibilityInsertFailure> {
    reactivate_target_application(target_app, target_app_bundle_id)?;
    std::thread::sleep(std::time::Duration::from_millis(35));

    let system_wide = unsafe { AXUIElementCreateSystemWide() };
    if system_wide.is_null() {
        return Err(AccessibilityInsertFailure::Other(
            if check_accessibility_permission() {
                "Accessibility could not create the system-wide element.".to_string()
            } else {
                "Accessibility could not create the system-wide element. macOS may still have direct cursor insertion disabled for this app copy."
                    .to_string()
            },
        ));
    }

    let focused_element = match ax_copy_attribute_value(system_wide, "AXFocusedUIElement") {
        Ok(Some(value)) => value,
        Ok(None) => {
            unsafe { CFRelease(system_wide) };
            return Err(AccessibilityInsertFailure::Other(
                if check_accessibility_permission() {
                    "Accessibility did not find a focused text element.".to_string()
                } else {
                    "Accessibility did not find a focused text element. macOS may still have direct cursor insertion disabled for this app copy."
                        .to_string()
                },
            ));
        }
        Err(error) => {
            unsafe { CFRelease(system_wide) };
            return Err(error.into());
        }
    };
    unsafe { CFRelease(system_wide) };

    // Password boxes and other secure inputs are refused before anything is
    // written. This runs on the element already in hand, so the common path
    // pays two attribute reads and nothing else.
    if let Some(signal) = classify_focused_element_security(focused_element) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::SecureField(signal));
    }

    let role = ax_copy_string_attribute(focused_element, "AXRole")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".to_string());

    let selected_text_settable = ax_is_attribute_settable(focused_element, "AXSelectedText")?;
    if selected_text_settable {
        match ax_set_string_attribute(focused_element, "AXSelectedText", text) {
            Ok(()) => {
                unsafe { CFRelease(focused_element) };
                return Ok(());
            }
            Err(error) => {
                tracing::warn!(
                    "AXSelectedText insertion failed for role '{}', trying AXValue fallback: {}",
                    role,
                    error
                );
            }
        }
    }

    let value_settable = ax_is_attribute_settable(focused_element, "AXValue")?;
    let selected_range_settable = ax_is_attribute_settable(focused_element, "AXSelectedTextRange")?;
    if value_settable {
        let current_value =
            ax_copy_string_attribute(focused_element, "AXValue")?.ok_or_else(|| {
                format!(
                    "Focused element role '{}' does not expose AXValue for direct insertion.",
                    role
                )
            })?;
        let selected_range = ax_copy_cf_range_attribute(focused_element, "AXSelectedTextRange")?
            .ok_or_else(|| {
                format!(
                    "Focused element role '{}' does not expose AXSelectedTextRange for direct insertion.",
                    role
                )
            })?;
        let (next_value, next_range) = replace_utf16_range(&current_value, selected_range, text)
            .ok_or_else(|| {
                format!(
                    "Accessibility could not apply the selected range inside the focused '{}' element.",
                    role
                )
            })?;

        ax_set_string_attribute(focused_element, "AXValue", &next_value)?;
        if selected_range_settable {
            let _ = ax_set_cf_range_attribute(focused_element, "AXSelectedTextRange", next_range);
        }
        unsafe { CFRelease(focused_element) };
        return Ok(());
    }

    unsafe { CFRelease(focused_element) };
    Err(AccessibilityInsertFailure::Other(format!(
        "Focused element role '{}' is not settable through macOS Accessibility, so Plainsong must fall back to paste.",
        role
    )))
}

/// Reactivates `target_app`/`target_app_bundle_id` (if needed) and copies the
/// system-wide `AXFocusedUIElement`, mirroring the focused-element lookup
/// that `insert_text_via_accessibility` performs inline. Factored out so the
/// selected-text-transform focused-field capture/replace helpers below can
/// share it without duplicating the reactivate+sleep+system-wide dance.
///
/// Returns `Ok(None)` (rather than an error) when accessibility is reachable
/// but no element currently has focus, so callers can fall back to another
/// capture strategy instead of surfacing a hard error.
#[cfg(target_os = "macos")]
pub(crate) fn copy_focused_accessibility_element(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
    system_wide_error: String,
) -> Result<Option<AXUIElementRef>, String> {
    reactivate_target_application(target_app, target_app_bundle_id)?;
    std::thread::sleep(std::time::Duration::from_millis(35));

    let system_wide = unsafe { AXUIElementCreateSystemWide() };
    if system_wide.is_null() {
        return Err(system_wide_error);
    }

    let focused_element = match ax_copy_attribute_value(system_wide, "AXFocusedUIElement") {
        Ok(Some(value)) => Some(value),
        Ok(None) => None,
        // `kAXErrorCannotComplete` from this specific lookup is macOS's way of
        // saying there is currently no reachable focus target for the
        // system-wide element (e.g. no window is frontmost/focused, or the
        // calling process lacks a live window server session) — treat it the
        // same as "no focused element" rather than a hard error, matching
        // this function's own contract, so callers fall back to another
        // capture strategy instead of surfacing an internal AX error string.
        Err(error) if is_ax_cannot_complete_error(&error) => None,
        Err(error) => {
            unsafe { CFRelease(system_wide) };
            return Err(error);
        }
    };
    unsafe { CFRelease(system_wide) };

    Ok(focused_element)
}

/// Whether an error string produced by `ax_copy_attribute_value` corresponds
/// to `kAXErrorCannotComplete` (`AXError -25204`). String-matched (rather
/// than threaded through as a typed error) because `ax_copy_attribute_value`
/// already collapses the AXError into a formatted `String` for every other
/// caller, and this is the one call site that needs to distinguish this
/// specific code from other failures.
#[cfg(target_os = "macos")]
pub(crate) fn is_ax_cannot_complete_error(error: &str) -> bool {
    error.contains(&format!("AXError {}", AX_ERROR_CANNOT_COMPLETE))
}

/// Reads the current text value of the system-wide focused element, without
/// requiring an explicit text selection. Used as the Quick-Fix-style
/// fallback when `capture_selected_text_via_clipboard` finds no selection:
/// e.g. the user places the caret in a field (no highlighted text) and runs
/// a command that should operate on the whole field.
///
/// Returns `Ok(None)` (not an error) whenever there's no usable focused
/// text field, so `capture_selected_text_transform_target` can fall back to
/// its own "select text" error message instead of surfacing an internal
/// accessibility detail.
#[cfg(target_os = "macos")]
pub(crate) fn capture_focused_field_text_via_accessibility(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(focused_element) = copy_focused_accessibility_element(
        target_app,
        target_app_bundle_id,
        "Accessibility could not create the system-wide element.".to_string(),
    )?
    else {
        return Ok(None);
    };

    let value_settable = ax_is_attribute_settable(focused_element, "AXValue")?;
    if !value_settable {
        unsafe { CFRelease(focused_element) };
        return Ok(None);
    }

    let current_value = ax_copy_string_attribute(focused_element, "AXValue")?;
    unsafe { CFRelease(focused_element) };

    Ok(current_value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

/// Owning process of an Accessibility element, used as the first and cheapest
/// part of the focused-field fingerprint.
#[cfg(target_os = "macos")]
pub(crate) fn ax_element_pid(element: AXUIElementRef) -> Option<i32> {
    let mut pid: i32 = 0;
    let error = unsafe { AXUIElementGetPid(element, &mut pid) };
    if error == AX_ERROR_SUCCESS && pid > 0 {
        Some(pid)
    } else {
        None
    }
}

/// Screen rectangle of an Accessibility element, rounded to whole points.
///
/// This is what separates two text fields that a Chromium app describes
/// identically — see `FocusedFieldFrame`. Both `AXPosition` and `AXSize` have
/// to decode, because half a rectangle is not an identity.
#[cfg(target_os = "macos")]
pub(crate) fn ax_element_frame(
    element: AXUIElementRef,
) -> Option<dictation_correction_capture::FocusedFieldFrame> {
    let position = ax_copy_cg_pair_attribute(element, "AXPosition", AX_VALUE_CG_POINT_TYPE)?;
    let size = ax_copy_cg_pair_attribute(element, "AXSize", AX_VALUE_CG_SIZE_TYPE)?;
    Some(dictation_correction_capture::FocusedFieldFrame {
        x: position.0.round() as i64,
        y: position.1.round() as i64,
        width: size.0.round() as i64,
        height: size.1.round() as i64,
    })
}

/// Decodes an `AXValue` that wraps a `CGPoint` or `CGSize` — both are two
/// `CGFloat`s in a row, so one decoder covers them.
#[cfg(target_os = "macos")]
pub(crate) fn ax_copy_cg_pair_attribute(
    element: AXUIElementRef,
    attribute: &str,
    value_type: u32,
) -> Option<(f64, f64)> {
    let value = ax_copy_attribute_value(element, attribute).ok().flatten()?;
    if unsafe { AXValueGetType(value) } != value_type {
        unsafe { CFRelease(value) };
        return None;
    }

    let mut pair: [f64; 2] = [0.0, 0.0];
    let copied = unsafe {
        AXValueGetValue(
            value,
            value_type,
            pair.as_mut_ptr() as *mut std::ffi::c_void,
        ) != 0
    };
    unsafe { CFRelease(value) };
    copied.then_some((pair[0], pair[1]))
}

/// `AXTitle` and `AXIdentifier` of the window a focused element belongs to.
/// Cheap, and it separates the same-looking field in two windows of one app.
#[cfg(target_os = "macos")]
pub(crate) fn ax_element_window_identity(
    element: AXUIElementRef,
) -> (Option<String>, Option<String>) {
    let Ok(Some(window)) = ax_copy_attribute_value(element, "AXWindow") else {
        return (None, None);
    };
    let title = ax_copy_string_attribute(window, "AXTitle").ok().flatten();
    let identifier = ax_copy_string_attribute(window, "AXIdentifier")
        .ok()
        .flatten();
    unsafe { CFRelease(window) };
    (title, identifier)
}

/// The real Accessibility read behind
/// `dictation_correction_capture::FocusedFieldReader`.
///
/// This is the only part of post-insert correction capture that cannot be
/// exercised by `cargo test`: it needs a granted Accessibility permission, a
/// window server session and a real focused field, none of which exist on CI.
/// Everything it feeds — the anchor check, the identity comparison, the span
/// location, the word alignment, every filter — is pure and tested against a
/// fake reader in `dictation_correction_capture`.
///
/// Deliberately *unlike* every other insertion-path helper in this file, it
/// does not call `reactivate_target_application` and does not sleep. It reads
/// whatever happens to be focused at this instant and reports who owns it; the
/// caller decides whether that is the same field it wrote into. Bringing an app
/// forward in order to read it would be both a focus theft and a way of
/// manufacturing the agreement the identity check is supposed to test for.
#[cfg(target_os = "macos")]
pub(crate) struct MacosFocusedFieldReader;

#[cfg(target_os = "macos")]
impl dictation_correction_capture::FocusedFieldReader for MacosFocusedFieldReader {
    fn read_focused_field(
        &self,
    ) -> Result<Option<dictation_correction_capture::FocusedFieldSnapshot>, String> {
        if !check_accessibility_permission() {
            return Ok(None);
        }

        let system_wide = unsafe { AXUIElementCreateSystemWide() };
        if system_wide.is_null() {
            return Ok(None);
        }
        let focused_element = match ax_copy_attribute_value(system_wide, "AXFocusedUIElement") {
            Ok(Some(value)) => value,
            Ok(None) => {
                unsafe { CFRelease(system_wide) };
                return Ok(None);
            }
            // Same reading as `copy_focused_accessibility_element`: no
            // reachable focus target is "nothing to read", not a failure.
            Err(error) if is_ax_cannot_complete_error(&error) => {
                unsafe { CFRelease(system_wide) };
                return Ok(None);
            }
            Err(error) => {
                unsafe { CFRelease(system_wide) };
                return Err(error);
            }
        };
        unsafe { CFRelease(system_wide) };

        let pid = ax_element_pid(focused_element);
        let role = ax_copy_string_attribute(focused_element, "AXRole")
            .ok()
            .flatten();
        let identifier = ax_copy_string_attribute(focused_element, "AXIdentifier")
            .ok()
            .flatten();
        let title = ax_copy_string_attribute(focused_element, "AXTitle")
            .ok()
            .flatten();
        let (window_title, window_identifier) = ax_element_window_identity(focused_element);
        let frame = ax_element_frame(focused_element);
        let text = ax_copy_string_attribute(focused_element, "AXValue")
            .ok()
            .flatten();
        unsafe { CFRelease(focused_element) };

        let Some(text) = text else {
            return Ok(None);
        };

        Ok(Some(dictation_correction_capture::FocusedFieldSnapshot {
            text,
            fingerprint: dictation_correction_capture::FocusedFieldFingerprint {
                pid,
                role,
                identifier,
                title,
                window_title,
                window_identifier,
                frame,
                frontmost_bundle_id: get_frontmost_app_bundle_id(),
                frontmost_app_name: get_frontmost_app_name(),
            },
        }))
    }
}

/// Stand-in on platforms with no Accessibility text read. Reports "nothing
/// focused", which every caller already treats as a silent abort.
#[cfg(not(target_os = "macos"))]
pub(crate) struct MacosFocusedFieldReader;

#[cfg(not(target_os = "macos"))]
impl dictation_correction_capture::FocusedFieldReader for MacosFocusedFieldReader {
    fn read_focused_field(
        &self,
    ) -> Result<Option<dictation_correction_capture::FocusedFieldSnapshot>, String> {
        Ok(None)
    }
}

/// Replaces the entire text value of the system-wide focused element with
/// `text`, then places the caret at the end of the new value. This is the
/// focused-field counterpart to `insert_text_via_accessibility`'s
/// selection-based insertion: it is used when the transform target was
/// captured via `capture_focused_field_text_via_accessibility` (no explicit
/// selection), so the whole field's contents must be overwritten rather
/// than a selected range.
#[cfg(target_os = "macos")]
pub(crate) fn replace_focused_field_text_via_accessibility(
    text: &str,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), AccessibilityInsertFailure> {
    let Some(focused_element) = copy_focused_accessibility_element(
        target_app,
        target_app_bundle_id,
        "Accessibility could not create the system-wide element.".to_string(),
    )?
    else {
        return Err(AccessibilityInsertFailure::Other(
            "Accessibility did not find a focused text element.".to_string(),
        ));
    };

    // Same refusal as cursor insertion: a whole-field replacement into a
    // password box is still a write into a password box.
    if let Some(signal) = classify_focused_element_security(focused_element) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::SecureField(signal));
    }

    let role = ax_copy_string_attribute(focused_element, "AXRole")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".to_string());
    let value_settable = ax_is_attribute_settable(focused_element, "AXValue")?;
    if !value_settable {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::Other(format!(
            "Focused element role '{}' does not allow replacing the focused field.",
            role
        )));
    }

    ax_set_string_attribute(focused_element, "AXValue", text)?;
    if ax_is_attribute_settable(focused_element, "AXSelectedTextRange").unwrap_or(false) {
        let caret = text.encode_utf16().count();
        if let Ok(location) = isize::try_from(caret) {
            let _ = ax_set_cf_range_attribute(
                focused_element,
                "AXSelectedTextRange",
                CFRange {
                    location,
                    length: 0,
                },
            );
        }
    }
    unsafe { CFRelease(focused_element) };
    Ok(())
}

/// System-wide entry point for replacing the focused field's full text
/// (Quick-Fix-style scope, no explicit selection): tries direct
/// Accessibility replacement first, then falls back to copying `text` to
/// the clipboard so the user can paste manually. Mirrors
/// `paste_text_systemwide`'s outcome shape/reporting so callers can treat
/// both paths uniformly.
pub(crate) fn replace_focused_field_text_systemwide(
    text: &str,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> PasteOutcome {
    #[cfg(target_os = "macos")]
    {
        match replace_focused_field_text_via_accessibility(text, target_app, target_app_bundle_id) {
            Ok(()) => {
                let copied = match copy_to_clipboard(text) {
                    Ok(()) => true,
                    Err(error) => {
                        tracing::warn!(
                            "Focused-field replacement succeeded but clipboard update failed: {}",
                            error
                        );
                        false
                    }
                };
                PasteOutcome {
                    pasted: true,
                    copied,
                    direct_accessibility: true,
                    confirmed: true,
                    successful_strategy: Some(CursorInsertStrategy::AccessibilityDirectText),
                    secure_field: None,
                    error: None,
                }
            }
            Err(AccessibilityInsertFailure::SecureField(signal)) => {
                secure_field_refusal_outcome(signal)
            }
            Err(AccessibilityInsertFailure::Other(error)) => {
                let copied = copy_to_clipboard(text).is_ok();
                PasteOutcome {
                    pasted: false,
                    copied,
                    direct_accessibility: false,
                    confirmed: false,
                    successful_strategy: None,
                    secure_field: None,
                    error: Some(format!(
                        "Result is ready, but Plainsong could not replace the focused field ({})",
                        error
                    )),
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = target_app;
        let _ = target_app_bundle_id;
        PasteOutcome {
            pasted: false,
            copied: copy_to_clipboard(text).is_ok(),
            direct_accessibility: false,
            confirmed: false,
            successful_strategy: None,
            secure_field: None,
            error: Some("Focused-field replacement is only implemented on macOS.".to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn reactivate_target_application(
    app_name: Option<&str>,
    app_bundle_id: Option<&str>,
) -> Result<(), String> {
    if is_self_activation_target(app_name, app_bundle_id) {
        return Ok(());
    }

    let trimmed_name = app_name.map(str::trim).filter(|value| !value.is_empty());
    let trimmed_bundle_id = app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if trimmed_name.is_none() && trimmed_bundle_id.is_none() {
        return Ok(());
    }

    let frontmost_bundle_matches = trimmed_bundle_id
        .and_then(|bundle_id| get_frontmost_app_bundle_id().map(|current| current == bundle_id))
        .unwrap_or(false);
    let frontmost_name_matches = trimmed_name
        .and_then(|name| get_frontmost_app_name().map(|current| current.eq_ignore_ascii_case(name)))
        .unwrap_or(false);
    if frontmost_bundle_matches || frontmost_name_matches {
        tracing::info!(
            "Target app '{}' is already frontmost; skipping app reactivation to preserve field focus",
            trimmed_name.or(trimmed_bundle_id).unwrap_or("unknown")
        );
        return Ok(());
    }

    let mut command = std::process::Command::new("/usr/bin/open");
    if let Some(bundle_id) = trimmed_bundle_id {
        command.args(["-b", bundle_id]);
    } else if let Some(name) = trimmed_name {
        command.args(["-a", name]);
    }

    let status = command.status().map_err(|error| {
        format!(
            "Failed to activate target app '{}': {}",
            trimmed_name.or(trimmed_bundle_id).unwrap_or("unknown"),
            error
        )
    })?;
    if !status.success() {
        return Err(format!(
            "macOS could not activate target '{}'.",
            trimmed_name.or(trimmed_bundle_id).unwrap_or("unknown"),
        ));
    }

    for _ in 0..18 {
        std::thread::sleep(std::time::Duration::from_millis(40));
        let bundle_matches = trimmed_bundle_id
            .and_then(|bundle_id| get_frontmost_app_bundle_id().map(|current| current == bundle_id))
            .unwrap_or(false);
        let name_matches = trimmed_name
            .and_then(|name| {
                get_frontmost_app_name().map(|current| current.eq_ignore_ascii_case(name))
            })
            .unwrap_or(false);
        if bundle_matches || name_matches {
            std::thread::sleep(std::time::Duration::from_millis(80));
            return Ok(());
        }
    }

    tracing::warn!(
        "Activation for target app '{}' did not confirm before paste dispatch",
        trimmed_name.or(trimmed_bundle_id).unwrap_or("unknown")
    );
    Ok(())
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn build_windows_sendkeys_script(
    keys: &str,
    target_identity: Option<&str>,
) -> Result<String, String> {
    let Some(target_identity) = target_identity else {
        return Ok(format!(
            "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{}')",
            escape_powershell_single_quoted(keys)
        ));
    };
    let identity = target_identity
        .strip_prefix("windows-hwnd-pid:")
        .ok_or_else(|| "Windows paste target identity is missing or invalid.".to_string())?;
    let (hwnd, process_id) = identity
        .split_once(':')
        .ok_or_else(|| "Windows paste target identity is missing or invalid.".to_string())?;
    let hwnd = hwnd
        .parse::<u64>()
        .map_err(|_| "Windows paste target HWND is invalid.".to_string())?;
    let process_id = process_id
        .parse::<u32>()
        .map_err(|_| "Windows paste target process ID is invalid.".to_string())?;

    Ok(format!(
        r#"Add-Type -AssemblyName System.Windows.Forms; Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PlainsongPasteTarget {{
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}}
"@; $target = [IntPtr]::new({hwnd}); $expectedPid = [uint32]{process_id}; if (-not [PlainsongPasteTarget]::IsWindow($target)) {{ exit 40 }}; $actualPid = 0; [void][PlainsongPasteTarget]::GetWindowThreadProcessId($target, [ref]$actualPid); if ($actualPid -ne $expectedPid) {{ exit 41 }}; if ([PlainsongPasteTarget]::GetForegroundWindow() -ne $target) {{ [void][PlainsongPasteTarget]::SetForegroundWindow($target) }}; $confirmed = $false; for ($i = 0; $i -lt 10; $i++) {{ $foreground = [PlainsongPasteTarget]::GetForegroundWindow(); $foregroundPid = 0; [void][PlainsongPasteTarget]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid); if ($foreground -eq $target -and $foregroundPid -eq $expectedPid) {{ $confirmed = $true; break }}; Start-Sleep -Milliseconds 20 }}; if (-not $confirmed) {{ exit 42 }}; $foreground = [PlainsongPasteTarget]::GetForegroundWindow(); $foregroundPid = 0; [void][PlainsongPasteTarget]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid); if ($foreground -ne $target -or $foregroundPid -ne $expectedPid) {{ exit 43 }}; [System.Windows.Forms.SendKeys]::SendWait('{}')"#,
        escape_powershell_single_quoted(keys)
    ))
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn build_windows_set_clipboard_script(payload_path: &Path) -> String {
    format!(
        "$utf8 = [System.Text.UTF8Encoding]::new($false); $text = [System.IO.File]::ReadAllText('{}', $utf8); Set-Clipboard -Value $text",
        escape_powershell_single_quoted(&payload_path.to_string_lossy())
    )
}

pub(crate) fn copy_to_clipboard(text: &str) -> Result<(), String> {
    tracing::info!("Copying {} chars to clipboard", text.len());

    #[cfg(target_os = "macos")]
    {
        use std::process::{Command, Stdio};
        let mut pbcopy = Command::new("/usr/bin/pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to launch pbcopy: {}", e))?;
        if let Some(stdin) = pbcopy.stdin.as_mut() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("Failed to write text to clipboard: {}", e))?;
        }
        let copy_status = pbcopy
            .wait()
            .map_err(|e| format!("Failed waiting for pbcopy: {}", e))?;
        if !copy_status.success() {
            return Err("pbcopy exited with failure status".to_string());
        }
        tracing::info!("Successfully copied to clipboard via pbcopy");
        Ok(())
    }

    #[cfg(target_os = "windows")]
    {
        use std::fs;
        use std::process::Command;

        let payload_path =
            std::env::temp_dir().join(format!("nautilus-clipboard-{}.txt", uuid::Uuid::new_v4()));

        fs::write(&payload_path, text.as_bytes())
            .map_err(|e| format!("Failed to stage clipboard payload: {}", e))?;

        let script = build_windows_set_clipboard_script(&payload_path);
        let status = Command::new("powershell")
            .args(["-NoProfile", "-Command", script.as_str()])
            .status()
            .map_err(|e| format!("Failed to launch Set-Clipboard: {}", e));

        let _ = fs::remove_file(&payload_path);

        let status = status?;
        if !status.success() {
            return Err("Set-Clipboard exited with failure status".to_string());
        }
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = text;
        Err("Clipboard copy is not implemented on this platform yet.".to_string())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn read_clipboard_text() -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/pbpaste")
        .output()
        .map_err(|e| format!("Failed to launch pbpaste: {}", e))?;
    if !output.status.success() {
        return Err("pbpaste exited with failure status".to_string());
    }
    String::from_utf8(output.stdout).map_err(|e| format!("Clipboard data was not utf-8: {}", e))
}

#[cfg(target_os = "windows")]
pub(crate) fn read_clipboard_text() -> Result<String, String> {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Clipboard -Raw"])
        .output()
        .map_err(|e| format!("Failed to launch Get-Clipboard: {}", e))?;
    if !output.status.success() {
        return Err("Get-Clipboard exited with failure status".to_string());
    }
    String::from_utf8(output.stdout).map_err(|e| format!("Clipboard data was not utf-8: {}", e))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn read_clipboard_text() -> Result<String, String> {
    Err("Clipboard read is not implemented on this platform yet.".to_string())
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Default)]
pub(crate) struct MacosKeyModifiers {
    command: bool,
    shift: bool,
    control: bool,
    option: bool,
}

#[cfg(target_os = "macos")]
pub(crate) fn dispatch_macos_keystroke(
    keycode: u16,
    modifiers: MacosKeyModifiers,
) -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const COMMAND_KEYCODE: CGKeyCode = 55;
    const SHIFT_KEYCODE: CGKeyCode = 56;
    const OPTION_KEYCODE: CGKeyCode = 58;
    const CONTROL_KEYCODE: CGKeyCode = 59;
    // Gap between synthetic key events. Long enough for target apps to register
    // the modifier/key sequence, short enough that a Cmd+V costs ~32ms of sleep
    // rather than ~200ms. (Was 50ms.)
    const KEYSTROKE_DELAY_MS: u64 = 8;
    const MAX_ATTEMPTS: usize = 2;

    let mut last_error: Option<String> = None;
    let flags = {
        let mut next = CGEventFlags::CGEventFlagNull;
        if modifiers.command {
            next.insert(CGEventFlags::CGEventFlagCommand);
        }
        if modifiers.shift {
            next.insert(CGEventFlags::CGEventFlagShift);
        }
        if modifiers.control {
            next.insert(CGEventFlags::CGEventFlagControl);
        }
        if modifiers.option {
            next.insert(CGEventFlags::CGEventFlagAlternate);
        }
        next
    };

    for attempt in 1..=MAX_ATTEMPTS {
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| "Failed to create event source".to_string())?;
        let target_keycode: CGKeyCode = keycode;

        let result = (|| -> Result<(), String> {
            let modifier_keys = [
                (modifiers.control, CONTROL_KEYCODE, "control"),
                (modifiers.option, OPTION_KEYCODE, "option"),
                (modifiers.shift, SHIFT_KEYCODE, "shift"),
                (modifiers.command, COMMAND_KEYCODE, "command"),
            ];

            for (enabled, modifier_keycode, label) in modifier_keys {
                if !enabled {
                    continue;
                }
                let modifier_down =
                    CGEvent::new_keyboard_event(source.clone(), modifier_keycode, true)
                        .map_err(|_| format!("Failed to create {} key down event", label))?;
                modifier_down.set_flags(flags);
                modifier_down.post(CGEventTapLocation::Session);
                std::thread::sleep(std::time::Duration::from_millis(KEYSTROKE_DELAY_MS));
            }

            let key_down = CGEvent::new_keyboard_event(source.clone(), target_keycode, true)
                .map_err(|_| "Failed to create target key down event".to_string())?;
            key_down.set_flags(flags);
            key_down.post(CGEventTapLocation::Session);

            std::thread::sleep(std::time::Duration::from_millis(KEYSTROKE_DELAY_MS));

            let key_up = CGEvent::new_keyboard_event(source.clone(), target_keycode, false)
                .map_err(|_| "Failed to create target key up event".to_string())?;
            key_up.set_flags(flags);
            key_up.post(CGEventTapLocation::Session);

            std::thread::sleep(std::time::Duration::from_millis(KEYSTROKE_DELAY_MS));

            for (enabled, modifier_keycode, label) in modifier_keys.into_iter().rev() {
                if !enabled {
                    continue;
                }
                let modifier_up =
                    CGEvent::new_keyboard_event(source.clone(), modifier_keycode, false)
                        .map_err(|_| format!("Failed to create {} key up event", label))?;
                modifier_up.post(CGEventTapLocation::Session);
                std::thread::sleep(std::time::Duration::from_millis(KEYSTROKE_DELAY_MS));
            }

            Ok(())
        })();

        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = Some(error);
                if attempt < MAX_ATTEMPTS {
                    std::thread::sleep(std::time::Duration::from_millis(KEYSTROKE_DELAY_MS));
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "Command keystroke failed".to_string()))
}

#[cfg(target_os = "macos")]
pub(crate) fn dispatch_command_keystroke(keycode: u16) -> Result<(), String> {
    dispatch_macos_keystroke(
        keycode,
        MacosKeyModifiers {
            command: true,
            ..MacosKeyModifiers::default()
        },
    )
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum PasteDispatchStatus {
    Confirmed,
    FallbackDispatched,
}

#[cfg(target_os = "macos")]
fn send_native_paste_key() -> Result<PasteDispatchStatus, String> {
    let system_events_error = match std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to keystroke \"v\" using command down")
        .output()
    {
        Ok(output) if output.status.success() => {
            tracing::info!("Cmd+V posted via System Events");
            return Ok(PasteDispatchStatus::Confirmed);
        }
        Ok(output) => format!(
            "System Events exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ),
        Err(error) => format!("Failed to invoke osascript for paste: {}", error),
    };

    // CGEvent::post has no delivery result. It remains useful as a fallback,
    // but must not be treated as confirmation that the target received the
    // paste (in particular when macOS silently denies event posting).
    dispatch_command_keystroke(9)
        .map(|()| {
            tracing::info!("Cmd+V posted via CoreGraphics fallback");
            PasteDispatchStatus::FallbackDispatched
        })
        .map_err(|error| {
            format!(
                "{}; CoreGraphics paste failed: {}",
                system_events_error, error
            )
        })
}

#[cfg(target_os = "macos")]
pub(crate) fn send_native_copy_key(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    reactivate_target_application(target_app, target_app_bundle_id)?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    dispatch_command_keystroke(8).map_err(|error| format!("CoreGraphics copy failed: {}", error))
}

#[cfg(target_os = "windows")]
pub(crate) fn send_native_copy_key(
    _target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    let script = build_windows_sendkeys_script("^c", target_app_bundle_id)?;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script.as_str()])
        .status()
        .map_err(|e| format!("Failed to launch PowerShell for copy: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err("Windows key simulation failed while sending Ctrl+C.".to_string())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn send_native_undo_key(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    let has_target = target_app
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || target_app_bundle_id
            .map(str::trim)
            .is_some_and(|value| !value.is_empty());
    if !has_target {
        return Err("Undo requires an identifiable target application.".to_string());
    }
    reactivate_target_application(target_app, target_app_bundle_id)?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    dispatch_command_keystroke(6).map_err(|error| format!("Undo keystroke failed: {}", error))
}

#[cfg(target_os = "windows")]
pub(crate) fn send_native_undo_key(
    _target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    let target_identity = target_app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Undo requires an identifiable target application.".to_string())?;
    let script = build_windows_sendkeys_script("^z", Some(target_identity))?;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script.as_str()])
        .status()
        .map_err(|e| format!("Failed to launch PowerShell for undo: {}", e))?;
    if status.success() {
        Ok(())
    } else {
        Err("Undo keystroke failed".to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn send_native_undo_key(
    _target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    Err("Undo command is not supported on this platform.".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn send_native_copy_key(
    _target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    Err("Copy command is not supported on this platform.".to_string())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn schedule_clipboard_restore(previous: String, inserted_text: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            DICTATION_PASTE_CLIPBOARD_RESTORE_DELAY_MS,
        ));

        match read_clipboard_text() {
            Ok(current) => {
                // Only restore if clipboard still contains the injected dictation text.
                // This avoids clobbering user clipboard changes made right after dictation.
                if current != inserted_text {
                    return;
                }
            }
            Err(_) => return,
        }

        if let Err(error) = copy_to_clipboard(&previous) {
            tracing::warn!(
                "Failed to restore previous clipboard after paste success: {}",
                error
            );
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn schedule_clipboard_restore(previous: String, inserted_text: String) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            DICTATION_PASTE_CLIPBOARD_RESTORE_DELAY_MS,
        ));

        match read_clipboard_text() {
            Ok(current) => {
                if current != inserted_text {
                    return;
                }
            }
            Err(_) => return,
        }

        if let Err(error) = copy_to_clipboard(&previous) {
            tracing::warn!(
                "Failed to restore previous clipboard after paste success: {}",
                error
            );
        }
    });
}

/// Why the native paste did not happen.
#[cfg(target_os = "macos")]
pub(crate) enum PasteDispatchFailure {
    /// The focused control, checked immediately before the clipboard was
    /// touched, is a password or other secure input. Nothing was staged.
    SecureField(dictation_secure_field::SecureFieldSignal),
    Other(String),
}

#[cfg(target_os = "macos")]
pub(crate) fn dispatch_paste_from_clipboard(
    text: &str,
    keep_text_in_clipboard: bool,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<CursorInsertStrategy, PasteDispatchFailure> {
    // Bring the target forward and look at the focused control immediately
    // before the clipboard is touched. Focus can move between any earlier
    // probe and this point (the direct-write attempt, the app coming
    // forward), and a password box that gained focus in that gap must
    // neither receive the paste nor see the words staged on the clipboard.
    // This is also the backstop for callers that never looked at the
    // focused element at all.
    reactivate_target_application(target_app, target_app_bundle_id)
        .map_err(PasteDispatchFailure::Other)?;
    std::thread::sleep(std::time::Duration::from_millis(50));
    if let Some(signal) = probe_focused_secure_field() {
        return Err(PasteDispatchFailure::SecureField(signal));
    }

    let previous_clipboard = read_clipboard_text().ok();
    copy_to_clipboard(text).map_err(|error| {
        PasteDispatchFailure::Other(format!("Failed to stage clipboard paste: {}", error))
    })?;

    match send_native_paste_key() {
        Ok(_status) => {
            // CoreGraphics only confirms that it posted the events, not that
            // the target received them. Still bound the lifetime of the
            // staged transcript when clipboard retention is disabled.
            if !keep_text_in_clipboard {
                if let Some(previous) = previous_clipboard {
                    schedule_clipboard_restore(previous, text.to_string());
                }
            }
            Ok(CursorInsertStrategy::SimulatedTyping)
        }
        Err(error) => {
            if !keep_text_in_clipboard {
                if let Some(previous) = previous_clipboard {
                    let _ = copy_to_clipboard(&previous);
                }
            }
            Err(PasteDispatchFailure::Other(
                if !(check_accessibility_permission() || check_post_event_access()) {
                    format!(
                    "Direct macOS text insertion is not enabled for Plainsong, and macOS also blocked the native Cmd+V fallback ({}). Grant Accessibility for this app copy.",
                    error
                )
                } else {
                    format!(
                    "macOS could not send Cmd+V at the cursor ({}). Click back into the target app and press Cmd+V manually if needed.",
                    error
                )
                },
            ))
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_selected_text_via_clipboard(
    target_app: Option<&str>,
) -> Result<Option<String>, String> {
    if !can_dispatch_hotkeys() {
        return Err(
            "Selected text capture needs macOS keyboard-event access or direct Accessibility insertion."
                .to_string(),
        );
    }

    // Look at the focused control before the clipboard is touched or Cmd+C
    // is sent: a password field is never read from, and its clipboard is
    // never replaced with the sentinel. The target is brought forward first
    // so the probe sees the field the copy would land in.
    reactivate_target_application(target_app, None)?;
    std::thread::sleep(std::time::Duration::from_millis(35));
    if let Some(signal) = probe_focused_secure_field() {
        return Err(dictation_secure_field::secure_field_capture_refusal_message(signal));
    }

    // If the clipboard can't even be read we can't restore it afterwards,
    // so bail out before overwriting it with the sentinel (a transient
    // pbpaste failure must not cost the user their clipboard contents).
    let original_clipboard = read_clipboard_text()
        .map_err(|error| format!("Could not snapshot the clipboard before capture: {}", error))?;
    let sentinel = format!(
        "__nautilus_context_capture_{}__",
        chrono::Utc::now().timestamp_millis()
    );
    copy_to_clipboard(&sentinel)?;

    // Restore the original clipboard on every exit path from here on —
    // returning early (e.g. when the copy keystroke fails) must never leave
    // the sentinel on the user's clipboard.
    if let Err(error) = send_native_copy_key(target_app, None) {
        let _ = copy_to_clipboard(&original_clipboard);
        return Err(error);
    }

    let mut captured: Option<String> = None;
    for _ in 0..6 {
        std::thread::sleep(std::time::Duration::from_millis(45));
        if let Ok(current) = read_clipboard_text() {
            if current != sentinel {
                captured = Some(current);
                break;
            }
        }
    }

    let _ = copy_to_clipboard(&original_clipboard);

    Ok(captured
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty()))
}

#[cfg(target_os = "windows")]
pub(crate) fn capture_selected_text_via_clipboard(
    target_app: Option<&str>,
) -> Result<Option<String>, String> {
    // See the macOS variant: snapshot first (bailing when unreadable), and
    // restore on every exit path so neither the sentinel nor the captured
    // selection is left behind on the user's clipboard.
    let original_clipboard = read_clipboard_text()
        .map_err(|error| format!("Could not snapshot the clipboard before capture: {}", error))?;
    let sentinel = format!(
        "__nautilus_context_capture_{}__",
        chrono::Utc::now().timestamp_millis()
    );
    copy_to_clipboard(&sentinel)?;

    if let Err(error) = send_native_copy_key(target_app, None) {
        let _ = copy_to_clipboard(&original_clipboard);
        return Err(error);
    }

    let mut captured: Option<String> = None;
    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        if let Ok(current) = read_clipboard_text() {
            if current != sentinel {
                captured = Some(current);
                break;
            }
        }
    }

    let _ = copy_to_clipboard(&original_clipboard);

    Ok(captured
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty()))
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_application_context_text(
    target_app: Option<&str>,
) -> Result<Option<String>, String> {
    let app_name = target_app
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(get_frontmost_app_name);
    let browser_host = get_frontmost_browser_url().and_then(|url| extract_host_from_url(&url));
    let selected_text = capture_selected_text_via_clipboard(target_app)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty());

    let mut sections = Vec::new();
    if let Some(name) = app_name {
        sections.push(format!("Active app: {}", name));
    }
    if let Some(host) = browser_host {
        sections.push(format!("Browser context: {}", host));
    }
    if let Some(selection) = selected_text {
        sections.push(format!("Selected text:\n{}", selection));
    }

    if sections.is_empty() {
        Ok(None)
    } else {
        Ok(Some(sections.join("\n\n")))
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn capture_application_context_text(
    target_app: Option<&str>,
) -> Result<Option<String>, String> {
    let app_name = target_app
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(get_frontmost_app_name);
    let window_title = get_frontmost_window_title();
    let selected_text = capture_selected_text_via_clipboard(target_app)
        .ok()
        .flatten()
        .filter(|value| !value.trim().is_empty());

    let mut sections = Vec::new();
    if let Some(name) = app_name {
        sections.push(format!("Active app: {}", name));
    }
    if let Some(title) = window_title {
        sections.push(format!("Window title: {}", title));
    }
    if let Some(selection) = selected_text {
        sections.push(format!("Selected text:\n{}", selection));
    }

    if sections.is_empty() {
        Ok(None)
    } else {
        Ok(Some(sections.join("\n\n")))
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn dispatch_paste_from_clipboard(
    _text: &str,
    _keep_text_in_clipboard: bool,
    _target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<CursorInsertStrategy, String> {
    let target_identity = target_app_bundle_id.ok_or_else(|| {
        "Windows paste was stopped because the original window identity is unavailable.".to_string()
    })?;
    let script = build_windows_sendkeys_script("^v", Some(target_identity))?;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", script.as_str()])
        .status()
        .map_err(|e| format!("Failed to launch PowerShell for paste: {}", e))?;
    if status.success() {
        Ok(CursorInsertStrategy::SimulatedTyping)
    } else {
        Err(
            "Windows key simulation failed while sending Ctrl+V. Paste manually with Ctrl+V."
                .to_string(),
        )
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn dispatch_paste_from_clipboard(
    _text: &str,
    _keep_text_in_clipboard: bool,
    _target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) -> Result<CursorInsertStrategy, String> {
    Err("System-wide paste is not implemented on this platform yet.".to_string())
}

pub(crate) fn capture_dictation_context_text(
    context_source: &str,
    target_app: Option<&str>,
) -> Result<Option<String>, String> {
    match normalize_dictation_context_source(context_source) {
        "none" => Ok(None),
        "clipboard" => read_clipboard_text()
            .map(|text| text.trim().to_string())
            .map(|text| if text.is_empty() { None } else { Some(text) }),
        "selected_text" => {
            #[cfg(target_os = "macos")]
            {
                capture_selected_text_via_clipboard(target_app)
            }
            #[cfg(target_os = "windows")]
            {
                capture_selected_text_via_clipboard(target_app)
            }
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            {
                let _ = target_app;
                Err("Selected text capture is not supported on this platform yet.".to_string())
            }
        }
        "application_context" => {
            #[cfg(target_os = "macos")]
            {
                capture_application_context_text(target_app)
            }
            #[cfg(target_os = "windows")]
            {
                capture_application_context_text(target_app)
            }
            #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
            {
                let app_name = target_app
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .or_else(get_frontmost_app_name);

                Ok(app_name.map(|name| format!("Active app: {}", name)))
            }
        }
        _ => Ok(None),
    }
}

pub(crate) fn mark_accessibility_insert_observed(observed: &AtomicBool) {
    observed.store(true, Ordering::Relaxed);
}

/// Blocking, and deliberately so: it shells out, waits on app activation, and
/// polls for the insert to land. It takes the one `AppState` flag it actually
/// touches rather than the whole struct so callers on the async runtime can hand
/// it to `spawn_blocking` without borrowing state across the await.
pub(crate) fn paste_text_systemwide(
    accessibility_trust_observed: &Arc<AtomicBool>,
    text: &str,
    keep_text_in_clipboard: bool,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> PasteOutcome {
    tracing::info!("paste_text_systemwide called with {} chars", text.len());

    #[cfg(target_os = "macos")]
    {
        let (target_app, target_app_bundle_id) =
            if is_self_activation_target(target_app, target_app_bundle_id) {
                (None, None)
            } else {
                (target_app, target_app_bundle_id)
            };

        match insert_text_via_accessibility_guarded(text, target_app, target_app_bundle_id) {
            Ok(()) => {
                mark_accessibility_insert_observed(accessibility_trust_observed);
                let copied = if keep_text_in_clipboard {
                    match copy_to_clipboard(text) {
                        Ok(()) => true,
                        Err(error) => {
                            tracing::warn!(
                                "Direct Accessibility insertion succeeded but clipboard update failed: {}",
                                error
                            );
                            false
                        }
                    }
                } else {
                    false
                };
                tracing::info!("Accessibility text insertion succeeded");
                return PasteOutcome {
                    pasted: true,
                    copied,
                    direct_accessibility: true,
                    confirmed: true,
                    successful_strategy: Some(CursorInsertStrategy::AccessibilityDirectText),
                    secure_field: None,
                    error: None,
                };
            }
            Err(AccessibilityInsertFailure::SecureField(signal)) => {
                return secure_field_refusal_outcome(signal);
            }
            Err(AccessibilityInsertFailure::Other(error)) => {
                tracing::warn!(
                    "Direct Accessibility insertion failed, falling back to native Cmd+V dispatch: {}",
                    error
                );
            }
        }

        // The paste fallback re-probes the focused control itself, right
        // before it touches the clipboard, so a secure field the direct
        // write could not see (or one that gained focus since) is refused
        // there rather than here.
        match dispatch_paste_from_clipboard(
            text,
            keep_text_in_clipboard,
            target_app,
            target_app_bundle_id,
        ) {
            Ok(strategy) => {
                let copied = if keep_text_in_clipboard {
                    match copy_to_clipboard(text) {
                        Ok(()) => true,
                        Err(error) => {
                            tracing::warn!(
                                "Native Cmd+V fallback succeeded but clipboard update failed: {}",
                                error
                            );
                            false
                        }
                    }
                } else {
                    false
                };

                tracing::info!("Native Cmd+V fallback succeeded");
                PasteOutcome {
                    pasted: true,
                    copied,
                    direct_accessibility: false,
                    confirmed: false,
                    successful_strategy: Some(strategy),
                    secure_field: None,
                    error: None,
                }
            }
            Err(PasteDispatchFailure::SecureField(signal)) => secure_field_refusal_outcome(signal),
            Err(PasteDispatchFailure::Other(insert_error)) => {
                if let Err(error) = copy_to_clipboard(text) {
                    tracing::error!(
                        "Failed to copy to clipboard after insert failure: {}",
                        error
                    );
                    return PasteOutcome {
                        pasted: false,
                        copied: false,
                        direct_accessibility: false,
                        confirmed: false,
                        successful_strategy: None,
                        secure_field: None,
                        error: Some(error),
                    };
                }
                tracing::info!("Text copied to clipboard successfully after insert failure");
                PasteOutcome {
                    pasted: false,
                    copied: true,
                    direct_accessibility: false,
                    confirmed: false,
                    successful_strategy: None,
                    secure_field: None,
                    error: Some(format!("Copied to clipboard. {}", insert_error)),
                }
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let original_clipboard = {
            #[cfg(target_os = "windows")]
            {
                read_clipboard_text().ok()
            }
            #[cfg(not(target_os = "windows"))]
            {
                None::<String>
            }
        };

        if let Err(error) = copy_to_clipboard(text) {
            tracing::error!("Failed to copy to clipboard: {}", error);
            return PasteOutcome {
                pasted: false,
                copied: false,
                direct_accessibility: false,
                confirmed: false,
                successful_strategy: None,
                secure_field: None,
                error: Some(error),
            };
        }
        tracing::info!("Text copied to clipboard successfully");

        let paste_dispatch = dispatch_paste_from_clipboard(
            text,
            keep_text_in_clipboard,
            target_app,
            target_app_bundle_id,
        );

        match paste_dispatch {
            Ok(strategy) => {
                // `copied` reports whether the dictated text is still on the
                // clipboard once the session settles, which is what the UI
                // promises the user. The staging copy above does not count:
                // with `keep_text_in_clipboard` off it is restored again.
                let mut left_on_clipboard = keep_text_in_clipboard;
                if !keep_text_in_clipboard {
                    match original_clipboard {
                        Some(previous) => schedule_clipboard_restore(previous, text.to_string()),
                        // Nothing to restore, so the staged text stays put.
                        None => left_on_clipboard = true,
                    }
                }
                PasteOutcome {
                    pasted: true,
                    copied: left_on_clipboard,
                    direct_accessibility: false,
                    confirmed: false,
                    successful_strategy: Some(strategy),
                    secure_field: None,
                    error: None,
                }
            }
            Err(error) => PasteOutcome {
                pasted: false,
                copied: true,
                direct_accessibility: false,
                confirmed: false,
                successful_strategy: None,
                secure_field: None,
                error: Some(format!("Copied to clipboard. {}", error)),
            },
        }
    }
}
