//! Secure-field refusal policy for dictation delivery.
//!
//! macOS marks password boxes and other secure inputs in two ways Plainsong
//! can observe before it writes anything: the focused Accessibility element
//! carries the `AXSecureTextField` role (or subrole, for wrapped controls),
//! and the OS turns on *secure event input* while such a field has focus —
//! the same switch Terminal's "Secure Keyboard Entry" and password managers
//! flip. Either signal means the recognized words must not be written or
//! pasted into the field, and must not be staged on the clipboard on the way
//! there. The words themselves are never lost: the transcript is committed to
//! dictation history before any delivery attempt.
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
    /// `IsSecureEventInputEnabled()` reported secure keyboard entry on. This
    /// is system-wide: a password field in any app, or an app that keeps it
    /// on (Terminal's Secure Keyboard Entry, password managers).
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
            SecureFieldSignal::SecureEventInput => "macOS secure event input is enabled",
        }
    }
}

/// The delivery decision, from the probed facts alone.
///
/// The role and subrole are matched exactly against `AXSecureTextField`
/// (ignoring surrounding whitespace and ASCII case, which some bridges vary).
/// A role match is reported ahead of the secure-event-input flag because it
/// names the actual control; the flag alone is reported when nothing about
/// the element itself said "secure" but the OS did.
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
            "macOS has secure keyboard entry turned on (a password field, or an app such as Terminal with Secure Keyboard Entry), so Plainsong did not insert or copy the words. They are kept in your dictation history."
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
            "macOS has secure keyboard entry turned on, so Plainsong did not copy anything from the field in front."
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
    fn secure_event_input_alone_is_refused_when_the_element_is_unknown() {
        // No Accessibility permission (or no focused element reported): the
        // OS flag is the only signal left, and it is enough.
        assert_eq!(
            classify_secure_field(None, None, true),
            Some(SecureFieldSignal::SecureEventInput)
        );
        assert_eq!(
            classify_secure_field(Some("AXTextField"), Some("AXUnknown"), true),
            Some(SecureFieldSignal::SecureEventInput)
        );
    }

    #[test]
    fn the_role_match_is_reported_ahead_of_the_system_wide_flag() {
        // Both are true for a real password box; the message should name the
        // control, not the system-wide switch.
        assert_eq!(
            classify_secure_field(Some("AXSecureTextField"), None, true),
            Some(SecureFieldSignal::SecureTextFieldRole)
        );
    }

    #[test]
    fn ordinary_text_controls_are_not_refused() {
        for role in [
            "AXTextField",
            "AXTextArea",
            "AXComboBox",
            "AXWebArea",
            "unknown",
            "",
        ] {
            assert_eq!(
                classify_secure_field(Some(role), None, false),
                None,
                "role '{}' must not be treated as secure",
                role
            );
        }
        assert_eq!(classify_secure_field(None, None, false), None);
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
        // A role that merely contains the word is not the secure role.
        assert_eq!(
            classify_secure_field(Some("AXSecureTextFieldContainer"), None, false),
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
    }

    #[test]
    fn reason_code_matches_the_renderer_contract() {
        // `describeDictationDeliveryRefusal` in src/lib/dictation-ui-message.ts
        // keys on this exact string.
        assert_eq!(SECURE_FIELD_REASON_CODE, "secure_field");
    }
}
