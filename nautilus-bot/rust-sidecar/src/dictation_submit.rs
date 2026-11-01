//! "Press Return after inserting": a per-binding opt-in that submits a chat or
//! AI prompt box once the dictated words are in it.
//!
//! Return is sent at most once, and only after delivery itself confirmed the
//! text (an Accessibility read-back, or the target requesting the pasted
//! text) and the original, non-secure field still has focus. Anything less
//! leaves the text unsent for the user to check.

use crate::text_insert::{DeliveryFieldFingerprint, PasteOutcome};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubmitFieldState {
    /// Focus is still on the field the text was delivered to.
    Unchanged,
    /// Focus moved, or the field cannot be identified.
    Changed,
    /// The focused control is a password or other secure input.
    Secure,
}

/// What the session knows after delivery, before the field is looked at again.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SubmitAfterInsertGate {
    /// The binding that started the session asked for Return.
    pub(crate) requested: bool,
    /// Insertion mode was anything but automatic insertion (clipboard only).
    pub(crate) clipboard_only: bool,
    /// The text came straight from dictation: no voice command, no undo of a
    /// previous insert, no rewrite of a selection.
    pub(crate) plain_dictation: bool,
    /// The session was cancelled or replaced before Return could be sent.
    pub(crate) cancelled: bool,
    /// Delivery put the text in the field: not refused, not copied only, not
    /// a secure field, no error.
    pub(crate) inserted: bool,
    /// Delivery saw it land: an Accessibility read-back, or the target
    /// requesting the pasted text.
    pub(crate) confirmed: bool,
}

impl SubmitAfterInsertGate {
    pub(crate) fn after(
        outcome: &PasteOutcome,
        requested: bool,
        clipboard_only: bool,
        plain_dictation: bool,
        cancelled: bool,
    ) -> Self {
        Self {
            requested,
            clipboard_only,
            plain_dictation,
            cancelled,
            inserted: outcome.pasted && outcome.error.is_none() && outcome.secure_field.is_none(),
            confirmed: outcome.confirmed || outcome.paste_requested,
        }
    }
}

fn preconditions_hold(gate: &SubmitAfterInsertGate) -> bool {
    gate.requested
        && !gate.clipboard_only
        && gate.plain_dictation
        && !gate.cancelled
        && gate.inserted
        && gate.confirmed
}

pub(crate) fn should_submit_after_insert(
    gate: &SubmitAfterInsertGate,
    field: SubmitFieldState,
) -> bool {
    preconditions_hold(gate) && field == SubmitFieldState::Unchanged
}

/// Whether `current` is still the field delivery wrote to. The native element
/// identity has to match; the frame does not, because a chat composer grows
/// as the words land in it (the same rule post-insert correction read-back
/// uses).
pub(crate) fn submit_field_state(
    expected: Option<&DeliveryFieldFingerprint>,
    current: Option<&DeliveryFieldFingerprint>,
) -> SubmitFieldState {
    let (Some(expected), Some(current)) = (expected, current) else {
        return SubmitFieldState::Changed;
    };
    if expected.same_field(current) {
        SubmitFieldState::Unchanged
    } else {
        SubmitFieldState::Changed
    }
}

/// Where focus is now. A secure field wins over identity.
pub(crate) fn probe_submit_field(
    expected: Option<&DeliveryFieldFingerprint>,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> SubmitFieldState {
    if crate::text_insert::probe_clipboard_delivery_secure_field().is_some() {
        return SubmitFieldState::Secure;
    }
    submit_field_state(
        expected,
        crate::text_insert::current_focused_field_fingerprint(target_app, target_app_bundle_id)
            .as_ref(),
    )
}

/// Looks at the field only when everything else already allows Return, and
/// calls `send_return` at most once. Returns whether Return was sent.
pub(crate) fn submit_after_insert(
    gate: &SubmitAfterInsertGate,
    probe_field: impl FnOnce() -> SubmitFieldState,
    send_return: impl FnOnce() -> Result<(), String>,
) -> bool {
    if !preconditions_hold(gate) || !should_submit_after_insert(gate, probe_field()) {
        return false;
    }
    match send_return() {
        Ok(()) => true,
        Err(error) => {
            tracing::warn!("Return after inserting was not sent: {}", error);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn outcome() -> PasteOutcome {
        PasteOutcome {
            pasted: true,
            copied: false,
            direct_accessibility: true,
            confirmed: true,
            paste_requested: false,
            successful_strategy: None,
            error: None,
            secure_field: None,
        }
    }

    fn gate(outcome: &PasteOutcome) -> SubmitAfterInsertGate {
        SubmitAfterInsertGate::after(outcome, true, false, true, false)
    }

    fn field() -> DeliveryFieldFingerprint {
        DeliveryFieldFingerprint {
            pid: Some(42),
            element_hash: Some(7),
            role: Some("AXTextArea".into()),
            identifier: Some("composer".into()),
            frame: Some(crate::dictation_correction_capture::FocusedFieldFrame::default()),
            app_bundle_id: Some("example.chat".into()),
            app_name: Some("Chat".into()),
        }
    }

    /// Every way Return must be withheld, each from an otherwise passing case.
    fn refusals() -> Vec<(&'static str, SubmitAfterInsertGate, SubmitFieldState)> {
        let allowed = gate(&outcome());
        let unconfirmed = PasteOutcome {
            direct_accessibility: false,
            confirmed: false,
            ..outcome()
        };
        let unverified_ax = PasteOutcome {
            confirmed: false,
            error: Some("Text was sent, but the field change could not be verified.".into()),
            ..outcome()
        };
        let refused = PasteOutcome {
            pasted: false,
            direct_accessibility: false,
            confirmed: false,
            error: Some("The frontmost application no longer matches.".into()),
            ..outcome()
        };
        let copied_only = PasteOutcome {
            pasted: false,
            copied: true,
            direct_accessibility: false,
            confirmed: false,
            ..outcome()
        };
        let secure = PasteOutcome {
            pasted: false,
            direct_accessibility: false,
            confirmed: false,
            secure_field: Some(crate::dictation_secure_field::SecureFieldSignal::SecureEventInput),
            ..outcome()
        };
        let same = SubmitFieldState::Unchanged;
        vec![
            (
                "flag off",
                SubmitAfterInsertGate {
                    requested: false,
                    ..allowed
                },
                same,
            ),
            ("unconfirmed paste", gate(&unconfirmed), same),
            ("unverified direct write", gate(&unverified_ax), same),
            ("refused", gate(&refused), same),
            ("copied only", gate(&copied_only), same),
            ("secure outcome", gate(&secure), same),
            ("secure field now", allowed, SubmitFieldState::Secure),
            ("field changed", allowed, SubmitFieldState::Changed),
            (
                "cancelled",
                SubmitAfterInsertGate {
                    cancelled: true,
                    ..allowed
                },
                same,
            ),
            (
                "clipboard only",
                SubmitAfterInsertGate {
                    clipboard_only: true,
                    ..allowed
                },
                same,
            ),
            (
                "voice command",
                SubmitAfterInsertGate {
                    plain_dictation: false,
                    ..allowed
                },
                same,
            ),
        ]
    }

    #[test]
    fn every_guard_withholds_return() {
        for (name, gate, field) in refusals() {
            assert!(!should_submit_after_insert(&gate, field), "{name}");
        }
    }

    #[test]
    fn a_confirmed_or_requested_insert_into_the_same_field_submits() {
        let read_back = outcome();
        assert!(should_submit_after_insert(
            &gate(&read_back),
            SubmitFieldState::Unchanged
        ));
        let requested = PasteOutcome {
            direct_accessibility: false,
            confirmed: false,
            paste_requested: true,
            ..outcome()
        };
        assert!(should_submit_after_insert(
            &gate(&requested),
            SubmitFieldState::Unchanged
        ));
    }

    #[test]
    fn the_key_sender_runs_exactly_once_and_only_when_allowed() {
        let sends = Cell::new(0);
        let probes = Cell::new(0);
        let allowed = outcome();
        assert!(submit_after_insert(
            &gate(&allowed),
            || {
                probes.set(probes.get() + 1);
                SubmitFieldState::Unchanged
            },
            || {
                sends.set(sends.get() + 1);
                Ok(())
            },
        ));
        assert_eq!((probes.get(), sends.get()), (1, 1));

        for (name, gate, field) in refusals() {
            let sends = Cell::new(0);
            let sent = submit_after_insert(
                &gate,
                || field,
                || {
                    sends.set(sends.get() + 1);
                    Ok(())
                },
            );
            assert!(!sent, "{name}");
            assert_eq!(sends.get(), 0, "{name}");
        }
    }

    #[test]
    fn the_field_is_not_read_when_delivery_already_rules_return_out() {
        let refused = PasteOutcome {
            pasted: false,
            confirmed: false,
            ..outcome()
        };
        let sent = submit_after_insert(
            &gate(&refused),
            || panic!("the field must not be read"),
            || panic!("Return must not be sent"),
        );
        assert!(!sent);
    }

    #[test]
    fn a_failed_send_is_not_retried_or_reported_as_sent() {
        let sends = Cell::new(0);
        let allowed = outcome();
        let sent = submit_after_insert(
            &gate(&allowed),
            || SubmitFieldState::Unchanged,
            || {
                sends.set(sends.get() + 1);
                Err("event source unavailable".into())
            },
        );
        assert!(!sent);
        assert_eq!(sends.get(), 1);
    }

    #[test]
    fn the_same_field_may_grow_but_not_change_identity() {
        let expected = field();
        let mut grown = field();
        grown.frame = Some(crate::dictation_correction_capture::FocusedFieldFrame {
            height: 120,
            ..Default::default()
        });
        assert_eq!(
            submit_field_state(Some(&expected), Some(&grown)),
            SubmitFieldState::Unchanged
        );

        let mut sibling = field();
        sibling.element_hash = Some(8);
        let mut other_app = field();
        other_app.pid = Some(43);
        let mut other_bundle = field();
        other_bundle.app_bundle_id = Some("example.other".into());
        let mut other_role = field();
        other_role.role = Some("AXTextField".into());
        for current in [sibling, other_app, other_bundle, other_role] {
            assert_eq!(
                submit_field_state(Some(&expected), Some(&current)),
                SubmitFieldState::Changed
            );
        }
        assert_eq!(
            submit_field_state(Some(&expected), None),
            SubmitFieldState::Changed
        );
        assert_eq!(
            submit_field_state(None, Some(&expected)),
            SubmitFieldState::Changed
        );

        let mut no_native_identity = field();
        no_native_identity.element_hash = None;
        assert_eq!(
            submit_field_state(Some(&no_native_identity), Some(&no_native_identity)),
            SubmitFieldState::Changed
        );
    }

    #[test]
    fn the_start_option_defaults_off_over_the_wire() {
        let options: crate::models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!options.submit_after_insert);
        assert!(!crate::models::DictationStartOptions::default().submit_after_insert);
        let options: crate::models::DictationStartOptions =
            serde_json::from_value(serde_json::json!({ "submitAfterInsert": true })).unwrap();
        assert!(options.submit_after_insert);
    }
}
