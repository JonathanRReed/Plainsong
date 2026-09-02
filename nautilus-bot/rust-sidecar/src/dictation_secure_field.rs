//! Secure-field refusal policy for dictation delivery.
//!
//! macOS marks password boxes and other secure inputs in two ways Plainsong
//! can observe before it writes anything: the focused Accessibility element
//! carries the `AXSecureTextField` role (or subrole, for wrapped controls),
//! and the OS turns on *secure event input* while such a field has focus —
//! the same switch Terminal's "Secure Keyboard Entry" and password managers
//! flip. A secure role means the recognized words must not be written or
//! pasted into the field, and must not be staged on the clipboard on the way
//! there. The words themselves are never lost: the transcript is committed to
//! dictation history before any delivery attempt.
//!
//! The two signals are not equal. The role describes the control in front;
//! the secure-event-input flag is system-wide and stays on for as long as
//! *any* app holds it (Terminal keeps it on while it runs with Secure
//! Keyboard Entry ticked). So the role is the primary signal, and the flag
//! only decides when the element could not be inspected — no Accessibility
//! permission, or no focused element reported. With Accessibility granted,
//! an ordinary text field in another app still takes dictation while
//! Terminal has secure entry on.
//!
//! The probing lives with the other Accessibility code in `lib.rs` (it needs
//! a live AX tree). This module is the decision, kept pure so the policy is
//! tested without one.

/// The `outcome` / reason code the sidecar reports for a refused delivery.
/// Mirrored by `describeDictationDeliveryRefusal` in the renderer.
pub const SECURE_FIELD_REASON_CODE: &str = "secure_field";

/// The Accessibility role (and, for wrapped controls, subrole) macOS gives a
/// password box and every other `NSSecureTextField`-style control, including
/// `<input type="password">` in Safari, Chrome and Electron apps.
pub const SECURE_TEXT_FIELD_ROLE: &str = "AXSecureTextField";

/// Which observed fact made the focused control secure. Kept distinct so the
/// log line and the user message can say what was actually seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecureFieldSignal {
    /// The focused element's `AXRole` is `AXSecureTextField`.
    SecureTextFieldRole,
    /// The focused element's `AXSubrole` is `AXSecureTextField` (a secure
    /// field wrapped in a generic container role).
    SecureTextFieldSubrole,
    /// `IsSecureEventInputEnabled()` reported secure keyboard entry on *and*
    /// the focused element could not be inspected, so the system-wide flag
    /// was the only signal available.
    SecureEventInput,
}

impl SecureFieldSignal {
    /// Short, log-friendly description of the signal.
    pub fn describe(self) -> &'static str {
        match self {
            SecureFieldSignal::SecureTextFieldRole => "focused element role is AXSecureTextField",
            SecureFieldSignal::SecureTextFieldSubrole => {
                "focused element subrole is AXSecureTextField"
            }
            SecureFieldSignal::SecureEventInput => {
                "macOS secure event input is enabled and the focused element could not be inspected"
            }
        }
    }
}

/// The delivery decision, from the probed facts alone.
///
/// The role and subrole are matched exactly against `AXSecureTextField`
/// (ignoring surrounding whitespace and ASCII case, which some bridges vary).
/// When neither matches but the role is usable — the element was inspected
/// and says it is an ordinary control — the answer is "not secure" whatever
/// the system-wide flag says. The flag decides only when there is no usable
/// role: Accessibility unavailable, no focused element, or a role the bridge
/// could not name.
pub fn classify_secure_field(
    role: Option<&str>,
    subrole: Option<&str>,
    secure_event_input: bool,
) -> Option<SecureFieldSignal> {
    if is_secure_text_field_role(role) {
        return Some(SecureFieldSignal::SecureTextFieldRole);
    }
    if is_secure_text_field_role(subrole) {
        return Some(SecureFieldSignal::SecureTextFieldSubrole);
    }
    if is_usable_role(role) {
        return None;
    }
    if secure_event_input {
        return Some(SecureFieldSignal::SecureEventInput);
    }
    None
}

fn is_secure_text_field_role(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|role| role.eq_ignore_ascii_case(SECURE_TEXT_FIELD_ROLE))
}

/// A role that actually describes the element. `lib.rs` substitutes
/// "unknown" when the attribute is missing, and an empty string is the same
/// non-answer.
fn is_usable_role(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|role| !role.is_empty() && !role.eq_ignore_ascii_case("unknown"))
}

/// Plain-language message for a refused *insertion*: what the field is, what
/// Plainsong did not do, and where the words are. Surfaced as `pasteError`
/// and in the insertion action record.
pub fn secure_field_refusal_message(signal: SecureFieldSignal) -> String {
    match signal {
        SecureFieldSignal::SecureTextFieldRole | SecureFieldSignal::SecureTextFieldSubrole => {
            "The field in front is a password or secure input, so Plainsong did not insert or copy the words. They are kept in your dictation history."
                .to_string()
        }
        SecureFieldSignal::SecureEventInput => {
            "macOS has secure keyboard entry turned on (a password field, or an app such as Terminal with Secure Keyboard Entry) and Plainsong could not inspect the field in front, so it did not insert or copy the words. They are kept in your dictation history. Granting Accessibility lets Plainsong tell an ordinary field apart."
                .to_string()
        }
    }
}

/// Plain-language message for a refused *selection capture* (the synthetic
/// Cmd+C used to read selected text for context and text commands).
pub fn secure_field_capture_refusal_message(signal: SecureFieldSignal) -> String {
    match signal {
        SecureFieldSignal::SecureTextFieldRole | SecureFieldSignal::SecureTextFieldSubrole => {
            "The field in front is a password or secure input, so Plainsong did not copy anything from it."
                .to_string()
        }
        SecureFieldSignal::SecureEventInput => {
            "macOS has secure keyboard entry turned on and Plainsong could not inspect the field in front, so it did not copy anything from it."
                .to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_text_field_role_is_refused_even_without_secure_event_input() {
        assert_eq!(
            classify_secure_field(Some("AXSecureTextField"), None, false),
            Some(SecureFieldSignal::SecureTextFieldRole)
        );
    }

    #[test]
    fn secure_text_field_subrole_is_refused_when_the_role_is_generic() {
        // A password box wrapped in a group/custom control reports its
        // security through the subrole; the role alone says nothing.
        assert_eq!(
            classify_secure_field(Some("AXTextField"), Some("AXSecureTextField"), false),
            Some(SecureFieldSignal::SecureTextFieldSubrole)
        );
    }

    #[test]
    fn terminal_secure_keyboard_entry_does_not_block_ordinary_fields_it_can_see() {
        // The flag is system-wide: Terminal with Secure Keyboard Entry ticked
        // keeps it on for as long as Terminal runs. A focused AXTextField in
        // Slack, inspected and found ordinary, must still take dictation.
        assert_eq!(classify_secure_field(Some("AXTextField"), None, true), None);
        assert_eq!(
            classify_secure_field(Some("AXTextArea"), Some("AXUnknown"), true),
            None
        );
        assert_eq!(classify_secure_field(Some("AXWebArea"), None, true), None);
    }

    #[test]
    fn secure_event_input_decides_only_when_the_element_cannot_be_inspected() {
        // No Accessibility permission, no focused element, or a role the
        // bridge could not name: the OS flag is the only signal left, and it
        // is enough to refuse.
        for role in [
            None,
            Some(""),
            Some("   "),
            Some("unknown"),
            Some("Unknown"),
        ] {
            assert_eq!(
                classify_secure_field(role, None, true),
                Some(SecureFieldSignal::SecureEventInput),
                "role {:?} is not usable, so the flag must decide",
                role
            );
        }
        // ...and with the flag off, an uninspectable element is not refused.
        assert_eq!(classify_secure_field(None, None, false), None);
        assert_eq!(classify_secure_field(Some("unknown"), None, false), None);
    }

    #[test]
    fn the_role_match_is_reported_ahead_of_the_system_wide_flag() {
        // Both are true for a real password box; the message should name the
        // control, not the system-wide switch.
        assert_eq!(
            classify_secure_field(Some("AXSecureTextField"), None, true),
            Some(SecureFieldSignal::SecureTextFieldRole)
        );
        assert_eq!(
            classify_secure_field(None, Some("AXSecureTextField"), true),
            Some(SecureFieldSignal::SecureTextFieldSubrole)
        );
    }

    #[test]
    fn ordinary_text_controls_are_not_refused() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXWebArea"] {
            assert_eq!(
                classify_secure_field(Some(role), None, false),
                None,
                "role '{}' must not be treated as secure",
                role
            );
        }
        assert_eq!(
            classify_secure_field(Some("AXTextField"), Some("AXSearchField"), false),
            None
        );
    }

    #[test]
    fn role_matching_tolerates_whitespace_and_ascii_case_but_not_substrings() {
        assert_eq!(
            classify_secure_field(Some("  axsecuretextfield "), None, false),
            Some(SecureFieldSignal::SecureTextFieldRole)
        );
        // A role that merely contains the word is an ordinary (usable) role.
        assert_eq!(
            classify_secure_field(Some("AXSecureTextFieldContainer"), None, true),
            None
        );
    }

    #[test]
    fn refusal_messages_say_what_the_field_is_what_was_not_done_and_where_the_words_are() {
        for signal in [
            SecureFieldSignal::SecureTextFieldRole,
            SecureFieldSignal::SecureTextFieldSubrole,
            SecureFieldSignal::SecureEventInput,
        ] {
            let message = secure_field_refusal_message(signal);
            assert!(
                message.contains("password") || message.contains("secure keyboard entry"),
                "{message}"
            );
            assert!(message.contains("did not insert or copy"), "{message}");
            assert!(message.contains("dictation history"), "{message}");

            let capture = secure_field_capture_refusal_message(signal);
            assert!(capture.contains("did not copy"), "{capture}");
        }
        // The flag-only refusal says why the field could not be told apart.
        assert!(
            secure_field_refusal_message(SecureFieldSignal::SecureEventInput)
                .contains("could not inspect the field in front")
        );
    }

    #[test]
    fn reason_code_matches_the_renderer_contract() {
        // `describeDictationDeliveryRefusal` in src/lib/dictation-ui-message.ts
        // keys on this exact string.
        assert_eq!(SECURE_FIELD_REASON_CODE, "secure_field");
    }
}
