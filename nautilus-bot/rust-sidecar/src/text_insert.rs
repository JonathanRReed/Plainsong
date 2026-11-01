//! Putting dictated text where the cursor is.
//!
//! The macOS Accessibility (AX) bridge, the clipboard, the synthetic Cmd+V /
//! Cmd+C keystrokes, the secure-field probe that refuses to deliver
//! into a password box, and the permission checks that gate all of it. The
//! non-macOS arms are here too, so the platform split stays in one place.
//!
//! Everything here is `pub(crate)` and re-exported from `lib.rs`; the move did
//! not rename or re-sign anything.

use super::*;

mod correction_observer;
#[cfg(any(test, target_os = "macos"))]
mod inline_edit;
#[cfg(target_os = "macos")]
pub(crate) mod nearby_context;
#[cfg(any(test, target_os = "macos"))]
pub(crate) mod voice_edit;
pub(crate) use correction_observer::{
    correction_fallback_wait, observe_post_insert_correction, read_post_insert_correction_once,
    CorrectionCaptureSession, CorrectionWatchOutcome,
};

pub(crate) const DICTATION_FOCUS_CHANGED_MESSAGE: &str =
    "Focus changed while dictation was processing. Your words are ready to copy in Plainsong.";

/// Primitive, thread-safe identity only. It never retains an AX object or reads
/// the field value, and it is never serialized or persisted.
#[derive(Clone, Default, PartialEq, Eq)]
pub(crate) struct DeliveryFieldFingerprint {
    pub(crate) pid: Option<i32>,
    pub(crate) element_hash: Option<u64>,
    pub(crate) role: Option<String>,
    pub(crate) identifier: Option<String>,
    pub(crate) frame: Option<dictation_correction_capture::FocusedFieldFrame>,
    pub(crate) app_bundle_id: Option<String>,
    pub(crate) app_name: Option<String>,
}

impl std::fmt::Debug for DeliveryFieldFingerprint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("DeliveryFieldFingerprint([redacted])")
    }
}

impl DeliveryFieldFingerprint {
    fn usable(&self) -> bool {
        self.pid.is_some()
            && (self.element_hash.is_some() || self.identifier.is_some() || self.frame.is_some())
    }

    /// Whether both describe one field: same process, native element, role,
    /// identifier and app. The frame is ignored because auto-growing fields
    /// (Messages, Slack, Mail, browser textareas) resize as text changes;
    /// native element identity already separates identically described
    /// siblings. Without a native element identity nothing matches.
    pub(crate) fn same_field(&self, other: &Self) -> bool {
        self.pid.is_some()
            && self.element_hash.is_some()
            && self.pid == other.pid
            && self.element_hash == other.element_hash
            && self.role == other.role
            && self.identifier == other.identifier
            && self.app_bundle_id == other.app_bundle_id
            && self.app_name == other.app_name
    }
}

pub(crate) fn validate_delivery_field_identity(
    expected: Option<&DeliveryFieldFingerprint>,
    current: Option<&DeliveryFieldFingerprint>,
) -> Result<(), String> {
    match (
        expected.filter(|value| value.usable()),
        current.filter(|value| value.usable()),
    ) {
        (Some(expected), Some(current)) if expected == current => Ok(()),
        (Some(_), _) => Err(DICTATION_FOCUS_CHANGED_MESSAGE.to_string()),
        _ => Ok(()),
    }
}

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
    /// Accessibility writes are confirmed only after the expected field value
    /// is read back. Native paste is confirmed only when a readable anchor
    /// observes the expected value in the same field; event dispatch alone
    /// cannot prove delivery.
    pub(crate) confirmed: bool,
    /// Native paste only: the target read the staged text from the clipboard
    /// within the request window after Cmd+V. Weaker than `confirmed` (it
    /// says the app took the text, not where it put it).
    pub(crate) paste_requested: bool,
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FocusedApplicationIdentity {
    pid: i32,
    pub(crate) name: Option<String>,
    pub(crate) bundle_id: Option<String>,
}

#[cfg(target_os = "macos")]
pub(crate) fn focused_application_matches_target(
    focused: &FocusedApplicationIdentity,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> bool {
    let name_matches = target_app
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|expected| {
            focused
                .name
                .as_deref()
                .is_some_and(|actual| actual.eq_ignore_ascii_case(expected))
        })
        .unwrap_or(true);
    let bundle_matches = target_app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|expected| focused.bundle_id.as_deref() == Some(expected))
        .unwrap_or(true);
    name_matches && bundle_matches
}

#[cfg(target_os = "macos")]
pub(crate) fn focused_application_identity_unchanged(
    expected: &FocusedApplicationIdentity,
    current: &FocusedApplicationIdentity,
) -> bool {
    expected == current
}

#[cfg(target_os = "macos")]
fn should_route_word_document_to_native_paste(
    focused: Option<&FocusedApplicationIdentity>,
    role: Option<&str>,
    enabled: Option<bool>,
    secure: bool,
) -> bool {
    !secure
        && focused.and_then(|app| app.bundle_id.as_deref()) == Some("com.microsoft.Word")
        && role == Some("AXTextArea")
        && enabled == Some(false)
}

#[cfg(all(test, target_os = "macos"))]
mod focused_application_identity_tests {
    use super::*;

    fn fixture_identity() -> FocusedApplicationIdentity {
        FocusedApplicationIdentity {
            pid: 4242,
            name: Some("Target Editor".to_string()),
            bundle_id: Some("local.test.target-editor".to_string()),
        }
    }

    #[test]
    fn focused_application_requires_every_known_target_identity_to_match() {
        let identity = fixture_identity();

        assert!(focused_application_matches_target(
            &identity,
            Some("Target Editor"),
            Some("local.test.target-editor"),
        ));
        assert!(!focused_application_matches_target(
            &identity,
            Some("Another App"),
            Some("local.test.target-editor"),
        ));
        assert!(!focused_application_matches_target(
            &identity,
            Some("Target Editor"),
            Some("local.test.other"),
        ));
    }

    #[test]
    fn focused_application_recheck_rejects_pid_or_identity_changes() {
        let expected = fixture_identity();
        let mut changed_pid = fixture_identity();
        changed_pid.pid += 1;
        let mut changed_bundle = fixture_identity();
        changed_bundle.bundle_id = Some("local.test.other".to_string());

        assert!(focused_application_identity_unchanged(
            &expected,
            &fixture_identity()
        ));
        assert!(!focused_application_identity_unchanged(
            &expected,
            &changed_pid
        ));
        assert!(!focused_application_identity_unchanged(
            &expected,
            &changed_bundle
        ));
    }

    #[test]
    fn application_scoped_lookup_keeps_secure_field_refusal_policy() {
        assert!(dictation_secure_field::classify_secure_field(
            Some("AXTextField"),
            Some("AXSecureTextField"),
            false,
        )
        .is_some());
        assert!(dictation_secure_field::classify_secure_field(None, None, true,).is_some());
    }

    #[test]
    fn disabled_word_document_text_area_routes_to_native_paste() {
        let word = FocusedApplicationIdentity {
            pid: 4242,
            name: Some("Microsoft Word".to_string()),
            bundle_id: Some("com.microsoft.Word".to_string()),
        };

        assert!(should_route_word_document_to_native_paste(
            Some(&word),
            Some("AXTextArea"),
            Some(false),
            false,
        ));
    }

    #[test]
    fn word_routing_requires_verified_bundle_identity() {
        let wrong_bundle = FocusedApplicationIdentity {
            pid: 4242,
            name: Some("Microsoft Word".to_string()),
            bundle_id: Some("local.test.not-word".to_string()),
        };
        let unknown_bundle = FocusedApplicationIdentity {
            pid: 4242,
            name: Some("Microsoft Word".to_string()),
            bundle_id: None,
        };

        assert!(!should_route_word_document_to_native_paste(
            Some(&wrong_bundle),
            Some("AXTextArea"),
            Some(false),
            false,
        ));
        assert!(!should_route_word_document_to_native_paste(
            Some(&unknown_bundle),
            Some("AXTextArea"),
            Some(false),
            false,
        ));
        assert!(!should_route_word_document_to_native_paste(
            None,
            Some("AXTextArea"),
            Some(false),
            false,
        ));
    }

    #[test]
    fn word_routing_excludes_secure_and_non_document_fields() {
        let word = FocusedApplicationIdentity {
            pid: 4242,
            name: Some("Microsoft Word".to_string()),
            bundle_id: Some("com.microsoft.Word".to_string()),
        };

        assert!(!should_route_word_document_to_native_paste(
            Some(&word),
            Some("AXTextArea"),
            Some(false),
            true,
        ));
        assert!(!should_route_word_document_to_native_paste(
            Some(&word),
            Some("AXTextField"),
            Some(false),
            false,
        ));
        assert!(!should_route_word_document_to_native_paste(
            Some(&word),
            Some("AXTextArea"),
            Some(true),
            false,
        ));
    }

    #[test]
    fn native_paste_stops_before_clipboard_write_when_partial_snapshot_fails() {
        use std::cell::Cell;

        let writes = Cell::new(0);
        let paste_events = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || Err::<ClipboardSnapshot, _>("one declared type was unreadable".to_string()),
            |_, _| {
                writes.set(writes.get() + 1);
                Ok(7)
            },
            || 7,
            |_| {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
            |_, _| panic!("restore must not run before staging"),
        );

        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
        assert_eq!(paste_events.get(), 0);
    }

    #[test]
    fn oversized_snapshot_causes_no_clipboard_write_or_paste() {
        use std::cell::Cell;

        let writes = Cell::new(0);
        let paste_events = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                let mut entries = Vec::new();
                let mut total_bytes = 0;
                push_bounded_clipboard_entry(
                    &mut entries,
                    &mut total_bytes,
                    "custom.large-type".to_string(),
                    vec![0; 9],
                    8,
                )?;
                Ok(ClipboardSnapshot {
                    source_change_count: 4,
                    items: vec![entries],
                })
            },
            |_, _| {
                writes.set(writes.get() + 1);
                Ok(5)
            },
            || 5,
            |_| {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
            |_, _| Ok(true),
        );

        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
        assert_eq!(paste_events.get(), 0);
    }

    #[test]
    fn empty_clipboard_is_a_valid_preservation_snapshot() {
        use std::cell::Cell;

        let writes = Cell::new(0);
        let paste_events = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                Ok(ClipboardSnapshot {
                    source_change_count: 6,
                    items: Vec::new(),
                })
            },
            |_, _| {
                writes.set(writes.get() + 1);
                Ok(7)
            },
            || 7,
            |_| {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
            |_, _| Ok(true),
        );

        let (_, preservation) = result.unwrap();
        let (snapshot, change_count) = preservation.unwrap();
        assert!(snapshot.items.is_empty());
        assert_eq!(change_count, 7);
        assert_eq!(writes.get(), 1);
        assert_eq!(paste_events.get(), 1);
    }

    #[test]
    fn multi_format_snapshot_round_trips_every_item_and_type() {
        use std::cell::RefCell;

        let snapshot = ClipboardSnapshot {
            source_change_count: 11,
            items: vec![
                vec![
                    ClipboardEntry {
                        type_name: "public.utf8-plain-text".to_string(),
                        data: b"hello".to_vec(),
                    },
                    ClipboardEntry {
                        type_name: "public.rtf".to_string(),
                        data: b"{\\rtf1 hello}".to_vec(),
                    },
                ],
                vec![ClipboardEntry {
                    type_name: "public.png".to_string(),
                    data: vec![0x89, b'P', b'N', b'G'],
                }],
            ],
        };
        let clipboard = RefCell::new(None);

        assert!(restore_snapshot_if_owned(
            &snapshot,
            12,
            || 12,
            |restored| {
                clipboard.replace(Some(restored.clone()));
                Ok(())
            },
        )
        .unwrap());
        assert!(clipboard.borrow().as_ref() == Some(&snapshot));
    }

    #[test]
    fn staged_dictation_carries_the_clipboard_manager_skip_markers() {
        assert_eq!(
            staged_dictation_marker_types(),
            [
                "org.nspasteboard.ConcealedType",
                "org.nspasteboard.TransientType"
            ]
        );
    }

    #[test]
    fn clipboard_race_skips_restore() {
        use std::cell::Cell;

        let restores = Cell::new(0);
        let snapshot = ClipboardSnapshot {
            source_change_count: 11,
            items: Vec::new(),
        };
        let restored = restore_snapshot_if_owned(
            &snapshot,
            12,
            || 13,
            |_| {
                restores.set(restores.get() + 1);
                Ok(())
            },
        )
        .unwrap();

        assert!(!restored);
        assert_eq!(restores.get(), 0);
    }

    #[test]
    fn clipboard_race_before_staging_causes_no_write_or_paste() {
        use std::cell::Cell;

        let writes = Cell::new(0);
        let paste_events = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                Ok(ClipboardSnapshot {
                    source_change_count: 4,
                    items: Vec::new(),
                })
            },
            |snapshot, _| {
                if snapshot.is_some_and(|snapshot| snapshot.source_change_count != 5) {
                    return Err("clipboard changed".to_string());
                }
                writes.set(writes.get() + 1);
                Ok(6)
            },
            || 6,
            |_| {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
            |_, _| Ok(true),
        );

        assert!(result.is_err());
        assert_eq!(writes.get(), 0);
        assert_eq!(paste_events.get(), 0);
    }

    #[test]
    fn clipboard_race_after_staging_causes_no_paste_or_restore() {
        use std::cell::Cell;

        let paste_events = Cell::new(0);
        let restores = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                Ok(ClipboardSnapshot {
                    source_change_count: 4,
                    items: Vec::new(),
                })
            },
            |_, _| Ok(5),
            || 6,
            |_| {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
            |_, _| {
                restores.set(restores.get() + 1);
                Ok(true)
            },
        );

        assert!(result.is_err());
        assert_eq!(paste_events.get(), 0);
        assert_eq!(restores.get(), 0);
    }

    #[test]
    fn failed_post_clear_stage_does_not_overwrite_lost_clipboard_ownership() {
        use std::cell::Cell;

        let paste_events = Cell::new(0);
        let restoration_writes = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                Ok(ClipboardSnapshot {
                    source_change_count: 4,
                    items: Vec::new(),
                })
            },
            |snapshot, _| {
                let error = recover_after_failed_stage(
                    snapshot.unwrap(),
                    5,
                    "stage failed".to_string(),
                    |_, _| Ok(false),
                );
                Err(error)
            },
            || 6,
            |_| {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
            |_, _| {
                restoration_writes.set(restoration_writes.get() + 1);
                Ok(true)
            },
        );

        assert!(result.is_err());
        assert_eq!(paste_events.get(), 0);
        assert_eq!(restoration_writes.get(), 0);
    }

    #[test]
    fn clipboard_race_during_restore_reconstruction_causes_no_overwrite() {
        use std::cell::Cell;

        let change_count = Cell::new(8);
        let restoration_writes = Cell::new(0);
        let snapshot = ClipboardSnapshot {
            source_change_count: 7,
            items: Vec::new(),
        };
        let restored = prepare_and_restore_snapshot_if_owned(
            &snapshot,
            8,
            |_| {
                change_count.set(9);
                Ok(())
            },
            || change_count.get(),
            |_| {
                restoration_writes.set(restoration_writes.get() + 1);
                Ok(())
            },
        )
        .unwrap();

        assert!(!restored);
        assert_eq!(restoration_writes.get(), 0);
    }

    #[test]
    fn native_delivery_preservation_failure_does_not_copy_after_staging_refuses() {
        use std::cell::Cell;

        for failure in ["snapshot", "before_staging", "after_staging"] {
            let writes = Cell::new(0);
            let paste_events = Cell::new(0);
            let fallback_copies = Cell::new(0);
            let result = stage_and_dispatch_native_paste(
                "dictated text",
                || Ok(()),
                || {
                    if failure == "snapshot" {
                        Err("unreadable rich clipboard".to_string())
                    } else {
                        Ok(ClipboardSnapshot {
                            source_change_count: 4,
                            items: Vec::new(),
                        })
                    }
                },
                |_, _| {
                    if failure == "before_staging" {
                        return Err("clipboard ownership changed".to_string());
                    }
                    writes.set(writes.get() + 1);
                    Ok(5)
                },
                || 6,
                |_| {
                    paste_events.set(paste_events.get() + 1);
                    Ok(PasteDispatchStatus::Confirmed)
                },
                |_, _| panic!("another owner must not be overwritten"),
            );
            let outcome = native_paste_outcome(
                "dictated text",
                false,
                result.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
                |_| {
                    fallback_copies.set(fallback_copies.get() + 1);
                    Ok(())
                },
            );

            assert!(!outcome.pasted && !outcome.copied && !outcome.confirmed);
            assert!(outcome.error.is_some());
            assert_eq!(paste_events.get(), 0);
            assert_eq!(fallback_copies.get(), 0);
            assert_eq!(writes.get(), usize::from(failure == "after_staging"));
        }
    }

    #[test]
    fn native_delivery_focus_change_restores_owned_stage_without_paste_or_fallback_copy() {
        use std::cell::Cell;

        let expected = fixture_identity();
        let mut changed = expected.clone();
        changed.pid += 1;
        let paste_events = Cell::new(0);
        let fallback_copies = Cell::new(0);
        let restores = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                Ok(ClipboardSnapshot {
                    source_change_count: 4,
                    items: Vec::new(),
                })
            },
            |_, _| Ok(5),
            || 5,
            |_| {
                dispatch_verified_native_paste(
                    &expected,
                    || Some(changed.clone()),
                    || None,
                    || {
                        paste_events.set(paste_events.get() + 1);
                        Ok(PasteDispatchStatus::Confirmed)
                    },
                )
            },
            |_, _| {
                restores.set(restores.get() + 1);
                Ok(true)
            },
        );
        let outcome = native_paste_outcome(
            "dictated text",
            false,
            result.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
            |_| {
                fallback_copies.set(fallback_copies.get() + 1);
                Ok(())
            },
        );
        assert!(!outcome.pasted && !outcome.copied);
        assert_eq!(paste_events.get(), 0);
        assert_eq!(fallback_copies.get(), 0);
        assert_eq!(restores.get(), 1);
    }

    #[test]
    fn native_delivery_secure_focus_after_staging_is_not_pasted_or_copied() {
        use std::cell::Cell;

        let expected = fixture_identity();
        let paste_events = Cell::new(0);
        let result = dispatch_verified_native_paste(
            &expected,
            || Some(expected.clone()),
            || Some(dictation_secure_field::SecureFieldSignal::SecureTextFieldRole),
            || {
                paste_events.set(paste_events.get() + 1);
                Ok(PasteDispatchStatus::Confirmed)
            },
        );
        let outcome = native_paste_outcome(
            "dictated text",
            false,
            result.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
            |_| panic!("secure-field refusal must not copy"),
        );
        assert!(!outcome.pasted && !outcome.copied);
        assert!(outcome.secure_field.is_some());
        assert_eq!(paste_events.get(), 0);
    }

    #[test]
    fn native_delivery_wrong_starting_target_never_stages_or_copies() {
        let result = resolve_native_paste_target(
            Some(fixture_identity()),
            Some("Another App"),
            Some("local.test.another-app"),
        )
        .map(|_| -> (CursorInsertStrategy, bool, bool) {
            panic!("wrong target must stop before clipboard staging")
        });
        let outcome = native_paste_outcome("dictated text", false, result, |_| {
            panic!("wrong target must not fall back to copying")
        });
        assert!(!outcome.pasted && !outcome.copied);
        assert!(outcome.error.is_some());
    }

    #[test]
    fn native_delivery_stops_if_target_changes_during_secure_probe() {
        use std::cell::Cell;

        let expected = fixture_identity();
        let mut changed = expected.clone();
        changed.pid += 1;
        let probed = Cell::new(false);
        let result = dispatch_verified_native_paste(
            &expected,
            || {
                Some(if probed.get() {
                    changed.clone()
                } else {
                    expected.clone()
                })
            },
            || {
                probed.set(true);
                None
            },
            || panic!("changed target must never receive Cmd+V"),
        );
        let outcome = native_paste_outcome(
            "dictated text",
            false,
            result.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
            |_| panic!("changed target refusal must not copy"),
        );
        assert!(!outcome.pasted && !outcome.copied);
    }

    #[test]
    fn native_delivery_dispatch_failure_keeps_the_manual_copy_fallback() {
        use std::cell::Cell;

        let copies = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || {
                Ok(ClipboardSnapshot {
                    source_change_count: 4,
                    items: Vec::new(),
                })
            },
            |_, _| Ok(5),
            || 5,
            |_| {
                Err(PasteDispatchFailure::Other(
                    "event posting denied".to_string(),
                ))
            },
            |_, _| Ok(true),
        );
        let outcome = native_paste_outcome(
            "dictated text",
            false,
            result.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
            |text| {
                assert_eq!(text, "dictated text");
                copies.set(copies.get() + 1);
                Ok(())
            },
        );
        assert!(!outcome.pasted && outcome.copied && !outcome.confirmed);
        assert_eq!(copies.get(), 1);
    }

    #[test]
    fn native_delivery_retained_stage_is_restored_when_transport_retry_is_refused() {
        use std::cell::{Cell, RefCell};

        for race in ["focus", "secure", "clipboard"] {
            let expected = fixture_identity();
            let current = RefCell::new(expected.clone());
            let secure = Cell::new(false);
            let clipboard = RefCell::new((4, "original rich clipboard".to_string()));
            let snapshots = Cell::new(0);
            let fallback_events = Cell::new(0);
            let restores = Cell::new(0);
            let staged = stage_and_dispatch_native_paste(
                "dictated text",
                || {
                    verify_native_paste_target(
                        &expected,
                        || Some(current.borrow().clone()),
                        || None,
                    )
                },
                || {
                    snapshots.set(snapshots.get() + 1);
                    Ok(clipboard.borrow().1.clone())
                },
                |_, text| {
                    clipboard.replace((5, text.to_string()));
                    Ok(5)
                },
                || clipboard.borrow().0,
                |owned| {
                    send_native_paste_with_fallback(
                        || {
                            verify_staged_native_paste(
                                &expected,
                                || Some(current.borrow().clone()),
                                || {
                                    secure.get().then_some(dictation_secure_field::SecureFieldSignal::SecureTextFieldRole)
                                },
                                || clipboard.borrow().0,
                                owned,
                            )
                        },
                        || {
                            match race {
                                "focus" => current.borrow_mut().pid += 1,
                                "secure" => secure.set(true),
                                "clipboard" => {
                                    clipboard.replace((6, "new user copy".to_string()));
                                }
                                _ => unreachable!(),
                            }
                            Err("System Events failed".to_string())
                        },
                        || {
                            fallback_events.set(fallback_events.get() + 1);
                            Ok(())
                        },
                    )
                },
                |snapshot, owned| {
                    restore_snapshot_if_owned(
                        snapshot,
                        owned,
                        || clipboard.borrow().0,
                        |original| {
                            restores.set(restores.get() + 1);
                            clipboard.replace((6, original.clone()));
                            Ok(())
                        },
                    )
                },
            );
            let outcome = native_paste_outcome(
                "dictated text",
                true,
                staged.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
                |_| panic!("transport refusal must not copy again"),
            );
            assert!(!outcome.pasted && !outcome.copied && !outcome.confirmed);
            assert_eq!(snapshots.get(), 1, "retention still needs rollback");
            assert_eq!(fallback_events.get(), 0);
            if race == "clipboard" {
                assert_eq!(restores.get(), 0);
                assert_eq!(clipboard.borrow().1, "new user copy");
            } else {
                assert_eq!(restores.get(), 1);
                assert_eq!(clipboard.borrow().1, "original rich clipboard");
            }
        }
    }

    #[test]
    fn native_delivery_secure_focus_during_snapshot_never_stages_text() {
        use std::cell::Cell;

        let expected = fixture_identity();
        let secure = Cell::new(false);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || {
                verify_native_paste_target(
                    &expected,
                    || Some(expected.clone()),
                    || {
                        secure.get().then_some(
                            dictation_secure_field::SecureFieldSignal::SecureTextFieldRole,
                        )
                    },
                )
            },
            || {
                secure.set(true);
                Ok("original clipboard".to_string())
            },
            |_, _| panic!("protected focus after slow snapshot must stop staging"),
            || panic!("no staged clipboard exists"),
            |_| panic!("protected focus must stop paste"),
            |_, _| panic!("unchanged clipboard needs no restoration"),
        );
        let outcome = native_paste_outcome(
            "dictated text",
            true,
            result.map(|_| (CursorInsertStrategy::SimulatedTyping, false, false)),
            |_| panic!("secure refusal must not copy"),
        );
        assert!(!outcome.pasted && !outcome.copied);
        assert!(outcome.secure_field.is_some());
    }

    #[test]
    fn native_delivery_user_copy_during_readback_survives_without_false_copy_claim() {
        use std::cell::{Cell, RefCell};

        for retain in [false, true] {
            let clipboard = RefCell::new((4, "original clipboard".to_string()));
            let restores = Cell::new(0);
            let result = stage_and_dispatch_native_paste(
                "dictated text",
                || Ok(()),
                || Ok(clipboard.borrow().1.clone()),
                |_, text| {
                    clipboard.replace((5, text.to_string()));
                    Ok(5)
                },
                || clipboard.borrow().0,
                |_| Ok(PasteDispatchStatus::Confirmed),
                |_, _| panic!("dispatch succeeded"),
            )
            .map(|(_, preservation)| {
                let (confirmed, copied) = finish_native_paste_readback(
                    preservation,
                    retain,
                    || {
                        clipboard.replace((6, "new user copy".to_string()));
                        true
                    },
                    || panic!("confirmed paste needs no request check"),
                    |_| panic!("confirmed paste is not retained as unrequested"),
                    || clipboard.borrow().0,
                    |snapshot, owned| {
                        restore_snapshot_if_owned(
                            &snapshot,
                            owned,
                            || clipboard.borrow().0,
                            |original| {
                                restores.set(restores.get() + 1);
                                clipboard.replace((7, original.clone()));
                                Ok(())
                            },
                        )
                        .unwrap();
                    },
                )
                .unwrap();
                (CursorInsertStrategy::SimulatedTyping, confirmed, copied)
            });
            let outcome = native_paste_outcome("dictated text", retain, result, |_| {
                panic!("successful paste must never copy again")
            });
            assert!(outcome.pasted && outcome.confirmed);
            assert!(!outcome.copied);
            assert_eq!(restores.get(), 0);
            assert_eq!(clipboard.borrow().1, "new user copy");
        }
    }

    #[test]
    fn native_delivery_retained_success_reports_owned_stage_without_recopying() {
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || Ok("original clipboard".to_string()),
            |snapshot, text| {
                assert_eq!(snapshot.map(String::as_str), Some("original clipboard"));
                assert_eq!(text, "dictated text");
                Ok(5)
            },
            || 5,
            |_| Ok(PasteDispatchStatus::Confirmed),
            |_, _| panic!("dispatch succeeded"),
        )
        .map(|(_, preservation)| {
            let (confirmed, copied) = finish_native_paste_readback(
                preservation,
                true,
                || true,
                || panic!("confirmed paste needs no request check"),
                |_| panic!("confirmed paste is not retained as unrequested"),
                || 5,
                |_, _| panic!("successful retained clipboard must stay in place"),
            )
            .unwrap();
            (CursorInsertStrategy::SimulatedTyping, confirmed, copied)
        });
        let outcome = native_paste_outcome("dictated text", true, result, |_| {
            panic!("retained text is already staged")
        });
        assert!(outcome.pasted && outcome.confirmed && outcome.copied);
    }

    #[test]
    fn native_delivery_transport_fallback_rechecks_and_preserves_unconfirmed_status() {
        use std::cell::Cell;

        let expected = fixture_identity();
        let checks = Cell::new(0);
        let events = Cell::new(0);
        let result = stage_and_dispatch_native_paste(
            "dictated text",
            || Ok(()),
            || Ok("original clipboard".to_string()),
            |_, _| Ok(5),
            || 5,
            |owned| {
                send_native_paste_with_fallback(
                    || {
                        checks.set(checks.get() + 1);
                        verify_staged_native_paste(
                            &expected,
                            || Some(expected.clone()),
                            || None,
                            || 5,
                            owned,
                        )
                    },
                    || Err("System Events failed".to_string()),
                    || {
                        events.set(events.get() + 1);
                        Ok(())
                    },
                )
            },
            |_, _| panic!("successful dispatch must not roll back immediately"),
        )
        .map(|(status, preservation)| {
            assert_eq!(status, PasteDispatchStatus::FallbackDispatched);
            let (confirmed, copied) = finish_native_paste_readback(
                preservation,
                true,
                || false,
                || Some(true),
                |_| panic!("a requested paste is not retained as unrequested"),
                || 5,
                |_, _| panic!("text is retained"),
            )
            .unwrap();
            (CursorInsertStrategy::SimulatedTyping, confirmed, copied)
        });
        let outcome = native_paste_outcome("dictated text", true, result, |_| {
            panic!("successful dispatch must not write the clipboard again")
        });
        assert_eq!(checks.get(), 2);
        assert_eq!(events.get(), 1);
        assert!(outcome.pasted && outcome.copied && !outcome.confirmed);
    }

    #[test]
    fn unrequested_paste_is_not_reported_as_sent_and_keeps_text_for_manual_paste() {
        use std::cell::Cell;

        for (keep, still_owned) in [(false, true), (true, true), (false, false)] {
            let paste_events = Cell::new(0);
            let retained = Cell::new(None);
            let result = stage_and_dispatch_native_paste(
                "dictated text",
                || Ok(()),
                || Ok("original clipboard".to_string()),
                |_, _| Ok(5),
                || 5,
                |_| {
                    paste_events.set(paste_events.get() + 1);
                    Ok(PasteDispatchStatus::Confirmed)
                },
                |_, _| panic!("dispatch succeeded"),
            )
            .and_then(|(_, preservation)| {
                let (confirmed, copied) = finish_native_paste_readback(
                    preservation,
                    keep,
                    || false,
                    || Some(false),
                    |owned| {
                        retained.set(Some(owned));
                        still_owned
                    },
                    || panic!("retention is decided by the unrequested-text path"),
                    |_, _| panic!("unrequested text must not be replaced by the old clipboard"),
                )?;
                Ok((CursorInsertStrategy::SimulatedTyping, confirmed, copied))
            });
            let outcome = native_paste_outcome("dictated text", keep, result, |_| {
                panic!("unrequested paste must not copy again")
            });

            assert!(!outcome.pasted && !outcome.confirmed);
            assert_eq!(outcome.copied, still_owned);
            assert_eq!(retained.get(), Some(5));
            assert_eq!(paste_events.get(), 1, "never paste again automatically");
            let message = outcome.error.unwrap();
            assert!(message.starts_with("Plainsong couldn't confirm the paste."));
            assert!(message.contains("paste-last shortcut"));
            assert_eq!(message.contains("Cmd+V"), still_owned);
        }
    }

    #[test]
    fn command_shortcut_keycode_follows_the_keyboard_layout() {
        let qwerty = |keycode| match keycode {
            8 => Some('c'),
            9 => Some('v'),
            47 => Some('.'),
            _ => None,
        };
        let dvorak = |keycode| match keycode {
            8 => Some('j'),
            9 => Some('.'),
            34 => Some('c'),
            47 => Some('v'),
            _ => None,
        };
        let azerty = |keycode| match keycode {
            0 => Some('q'),
            8 => Some('c'),
            9 => Some('v'),
            12 => Some('a'),
            _ => None,
        };
        let no_latin = |keycode: u16| char::from_u32(0x0430 + u32::from(keycode));

        assert_eq!(command_shortcut_keycode('v', 9, qwerty), Some(9));
        assert_eq!(command_shortcut_keycode('v', 9, dvorak), Some(47));
        assert_eq!(command_shortcut_keycode('c', 8, dvorak), Some(34));
        assert_eq!(command_shortcut_keycode('v', 9, azerty), Some(9));
        assert_eq!(command_shortcut_keycode('v', 9, no_latin), None);
    }

    #[test]
    fn user_copy_during_scheduled_restore_window_wins() {
        use std::cell::RefCell;

        let clipboard = RefCell::new((5, "dictated text".to_string()));
        let scheduled = RefCell::new(None);
        let (confirmed, copied) = finish_native_paste_readback(
            Some(("original clipboard".to_string(), 5)),
            false,
            || true,
            || panic!("confirmed paste needs no request check"),
            |_| panic!("confirmed paste is not retained as unrequested"),
            || panic!("text is not retained"),
            |snapshot, owned| {
                scheduled.replace(Some((snapshot, owned)));
            },
        )
        .unwrap();
        assert!(confirmed && !copied);

        // The user copies before the delayed restore runs.
        clipboard.replace((6, "user copy".to_string()));
        let (snapshot, owned) = scheduled.into_inner().unwrap();
        let restored = prepare_and_restore_snapshot_if_owned(
            &snapshot,
            owned,
            |snapshot| Ok(snapshot.clone()),
            || clipboard.borrow().0,
            |original| {
                clipboard.replace((7, original));
                Ok(())
            },
        )
        .unwrap();

        assert!(!restored);
        assert_eq!(clipboard.borrow().1, "user copy");
    }

    #[test]
    fn paste_request_wait_returns_on_request_or_at_the_deadline() {
        use std::time::{Duration, Instant};

        let requested = Arc::new(AtomicBool::new(false));
        assert!(!wait_for_paste_request(&requested, Instant::now()));

        let started = Instant::now();
        let late = Arc::clone(&requested);
        let requester = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            late.store(true, Ordering::SeqCst);
        });
        assert!(wait_for_paste_request(
            &requested,
            started + Duration::from_secs(5)
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
        requester.join().unwrap();
    }

    #[test]
    fn accessibility_confirmation_requires_expected_text_and_current_focus() {
        use std::cell::Cell;

        assert!(!confirm_accessibility_text_change(
            "replacement",
            || true,
            || Some("old field".to_string()),
            || {},
        ));
        let reads = Cell::new(0);
        assert!(confirm_accessibility_text_change(
            "replacement",
            || true,
            || {
                reads.set(reads.get() + 1);
                Some(
                    if reads.get() == 2 {
                        "replacement"
                    } else {
                        "old field"
                    }
                    .to_string(),
                )
            },
            || {},
        ));
        assert!(!confirm_accessibility_text_change(
            "replacement",
            || false,
            || panic!("changed focus must stop readback"),
            || {},
        ));
    }

    #[test]
    fn selected_text_capture_restores_all_types_including_privacy_markers() {
        use std::cell::{Cell, RefCell};
        let original = ClipboardSnapshot {
            source_change_count: 10,
            items: vec![vec![
                ClipboardEntry {
                    type_name: "public.utf8-plain-text".into(),
                    data: b"synthetic-secret".to_vec(),
                },
                ClipboardEntry {
                    type_name: "org.nspasteboard.ConcealedType".into(),
                    data: vec![],
                },
                ClipboardEntry {
                    type_name: "org.nspasteboard.TransientType".into(),
                    data: vec![],
                },
                ClipboardEntry {
                    type_name: "public.html".into(),
                    data: b"<b>synthetic-secret</b>".to_vec(),
                },
                ClipboardEntry {
                    type_name: "com.example.binary".into(),
                    data: vec![0, 255],
                },
            ]],
        };
        for copy_fails in [false, true] {
            let current_count = Cell::new(11);
            let restored = RefCell::new(None);
            let captured = capture_selection_preserving_clipboard(
                || Ok(original.clone()),
                |_, _| Ok(11),
                || {
                    if copy_fails {
                        Err("copy refused".into())
                    } else {
                        current_count.set(12);
                        Ok(())
                    }
                },
                || Ok((12, " selected words ".into())),
                |snapshot, owned| {
                    restore_snapshot_if_owned(
                        snapshot,
                        owned,
                        || current_count.get(),
                        |snapshot| {
                            restored.replace(Some(snapshot.clone()));
                            Ok(())
                        },
                    )
                },
            );
            if copy_fails {
                assert_eq!(captured.unwrap_err(), "copy refused");
            } else {
                assert_eq!(captured.unwrap(), Some("selected words".into()));
            }
            assert!(restored
                .borrow()
                .as_ref()
                .is_some_and(|snapshot| snapshot.items == original.items));
        }
    }

    #[test]
    fn selected_text_capture_preserves_a_newer_copy_and_unreadable_clipboards() {
        use std::cell::Cell;
        let restored = Cell::new(false);
        let result = capture_selection_preserving_clipboard(
            || Ok(()),
            |_, _| Ok(1),
            || Ok(()),
            || Ok((2, "selection".into())),
            |snapshot, owned| {
                restore_snapshot_if_owned(
                    snapshot,
                    owned,
                    || 3,
                    |_| {
                        restored.set(true);
                        Ok(())
                    },
                )
            },
        );
        assert_eq!(result.unwrap(), Some("selection".into()));
        assert!(!restored.get());
        let result = capture_selection_preserving_clipboard(
            || Err::<(), _>("unreadable type".into()),
            |_, _| panic!("must not replace an unreadable clipboard"),
            || panic!("must not copy before preservation"),
            || panic!("must not read"),
            |_, _| panic!("nothing was changed"),
        );
        assert_eq!(result.unwrap_err(), "unreadable type");
    }

    #[test]
    #[ignore = "mutates the real macOS clipboard; run only during controlled QA"]
    fn macos_native_clipboard_round_trip_probe() {
        let original = match snapshot_macos_clipboard() {
            Ok(snapshot) => snapshot,
            Err(_) => panic!("original_snapshot_ok=false"),
        };
        let original_change_count = macos_clipboard_change_count();
        assert_eq!(original.source_change_count, original_change_count);

        let fixture = ClipboardSnapshot {
            source_change_count: original_change_count,
            items: vec![vec![
                ClipboardEntry {
                    type_name: "public.utf8-plain-text".to_string(),
                    data: b"Plainsong clipboard round-trip probe".to_vec(),
                },
                ClipboardEntry {
                    type_name: "public.html".to_string(),
                    data: b"<p>Plainsong clipboard round-trip probe</p>".to_vec(),
                },
                ClipboardEntry {
                    type_name: "com.plainsong.qa.binary".to_string(),
                    data: vec![0x00, 0x50, 0x4c, 0x41, 0xff],
                },
            ]],
        };

        let fixture_change_count = std::cell::Cell::new(None);
        let probe_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let staged =
                restore_macos_clipboard_if_owned(&fixture, original_change_count).unwrap_or(false);
            assert!(staged, "fixture_staged=false");
            let captured = match snapshot_macos_clipboard() {
                Ok(snapshot) => snapshot,
                Err(_) => panic!("fixture_snapshot_ok=false"),
            };
            assert_eq!(captured.items.len(), 1);
            assert_eq!(captured.items[0].len(), 3);
            assert!(captured.items == fixture.items, "fixture_equal=false");
            fixture_change_count.set(Some(captured.source_change_count));
        }));

        let expected_fixture_count = fixture_change_count.get();
        let ownership_unchanged = expected_fixture_count
            .is_some_and(|change_count| macos_clipboard_change_count() == change_count);
        let original_restored =
            if let Some(change_count) = expected_fixture_count.filter(|_| ownership_unchanged) {
                restore_macos_clipboard_if_owned(&original, change_count).unwrap_or(false)
            } else {
                false
            };

        if expected_fixture_count.is_some() {
            assert!(ownership_unchanged, "clipboard_ownership_unchanged=false");
            assert!(original_restored, "original_restored=false");
        }
        if let Err(payload) = probe_result {
            std::panic::resume_unwind(payload);
        }
    }
}

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
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> AXError;
    fn AXObserverCreate(
        pid: i32,
        callback: extern "C" fn(CFTypeRef, AXUIElementRef, CFStringRef, *mut std::ffi::c_void),
        observer: *mut CFTypeRef,
    ) -> AXError;
    fn AXObserverAddNotification(
        observer: CFTypeRef,
        element: AXUIElementRef,
        notification: CFStringRef,
        refcon: *mut std::ffi::c_void,
    ) -> AXError;
    fn AXObserverRemoveNotification(
        observer: CFTypeRef,
        element: AXUIElementRef,
        notification: CFStringRef,
    ) -> AXError;
    fn AXObserverGetRunLoopSource(
        observer: CFTypeRef,
    ) -> core_foundation_sys::runloop::CFRunLoopSourceRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        parameter: CFTypeRef,
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
            "Microphone access is off. Allow Plainsong in System Settings > Privacy & Security > Microphone."
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
            "Allow Plainsong in System Settings > Privacy & Security > Microphone.".to_string(),
        );
    }

    match request_microphone_permission() {
        Ok(true) => Ok(()),
        Ok(false) => Err(
            "Microphone access was not allowed. Allow Plainsong in System Settings > Privacy & Security > Microphone."
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

/// The Plainsong.app this process runs from. The sidecar lives in
/// `Contents/Resources/sidecar/`, not `Contents/MacOS/`, so this walks up to
/// the enclosing `.app` rather than assuming the main executable's layout
/// (which made it None in every packaged build, and with it the disk-image
/// warning and the app-copy diagnostics).
#[cfg(target_os = "macos")]
pub(crate) fn current_app_bundle_path() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    app_bundle_containing(&executable)
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn app_bundle_containing(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .skip(1)
        .find(|ancestor| {
            ancestor.extension().and_then(|ext| ext.to_str()) == Some("app")
                && ancestor.join("Contents").is_dir()
        })
        .map(Path::to_path_buf)
}

#[cfg(target_os = "macos")]
#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSRegisterURL(in_url: core_foundation::url::CFURLRef, in_update: Boolean) -> i32;
}

#[cfg(target_os = "macos")]
pub(crate) fn running_app_bundle_identity() -> Result<(PathBuf, String), String> {
    use core_foundation::bundle::{CFBundle, CFBundleGetIdentifier};

    let path = current_app_bundle_path()
        .ok_or_else(|| "Plainsong is not running from an app bundle.".to_string())?;
    let url = core_foundation::url::CFURL::from_path(&path, true)
        .ok_or_else(|| format!("Could not form a URL for {}", path.display()))?;
    let bundle =
        CFBundle::new(url).ok_or_else(|| "Could not read the running app bundle.".to_string())?;
    let identifier = unsafe { CFBundleGetIdentifier(bundle.as_concrete_TypeRef()) };
    if identifier.is_null() {
        return Err("The running app has no bundle identifier.".to_string());
    }
    let identifier = unsafe { CFString::wrap_under_get_rule(identifier) };
    if !(1..=128).contains(&identifier.char_len()) {
        return Err("The running app bundle identifier has an invalid length.".to_string());
    }
    Ok((path, identifier.to_string()))
}

/// Tells Launch Services that this copy is Plainsong. macOS resolves the
/// Accessibility switch through the bundle identifier; with a stale copy
/// registered (an old download, a mounted disk image, a deleted build) the
/// switch the user turns on can resolve to that copy, fail its code check and
/// vanish again.
#[cfg(target_os = "macos")]
pub(crate) fn register_app_bundle(bundle: &Path) -> Result<(), String> {
    let url = core_foundation::url::CFURL::from_path(bundle, true)
        .ok_or_else(|| format!("Could not form a URL for {}", bundle.display()))?;
    let status = unsafe { LSRegisterURL(url.as_concrete_TypeRef(), 1) };
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "Launch Services returned {status} for {}",
            bundle.display()
        ))
    }
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

#[cfg(any(test, target_os = "macos"))]
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
fn ax_copy_boolean_attribute(
    element: AXUIElementRef,
    attribute: &str,
) -> Result<Option<bool>, String> {
    let Some(value) = ax_copy_attribute_value(element, attribute)? else {
        return Ok(None);
    };

    let is_boolean = unsafe { CFGetTypeID(value) == CFBoolean::type_id() };
    if !is_boolean {
        unsafe { CFRelease(value) };
        return Ok(None);
    }

    let value = unsafe { CFBoolean::wrap_under_create_rule(value.cast()) };
    Ok(Some(bool::from(value)))
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

#[cfg(target_os = "macos")]
fn parse_lsappinfo_application_identity(output: &str) -> Option<FocusedApplicationIdentity> {
    // The name is only ever the leading quoted token. Without one,
    // `parse_lsappinfo_value` would read the first `key="value"`, which here
    // is the bundle id of an app that has no name.
    let name = output
        .trim_start()
        .starts_with('"')
        .then(|| parse_lsappinfo_value(output))
        .flatten();
    let bundle_id = output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("bundleID=\"")
            .and_then(|value| value.split('"').next())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    });
    let pid = output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("pid = ")
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<i32>().ok())
    })?;
    if pid <= 0 || (name.is_none() && bundle_id.is_none()) {
        return None;
    }
    Some(FocusedApplicationIdentity {
        pid,
        name,
        bundle_id,
    })
}

/// One running process, told apart from a later process that reuses its pid.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProcessInstance {
    pid: i32,
    started: (u64, u64),
}

#[cfg(target_os = "macos")]
const FRONTMOST_IDENTITY_MEMO_CAPACITY: usize = 8;

/// Names and bundle ids already read from LaunchServices, keyed by process
/// instance. A process keeps its name and bundle id for its whole life, so
/// only the frontmost pid has to be read fresh on each call.
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct FrontmostIdentityMemo {
    entries: std::collections::VecDeque<(ProcessInstance, FocusedApplicationIdentity)>,
}

#[cfg(target_os = "macos")]
impl FrontmostIdentityMemo {
    fn lookup(&self, front: ProcessInstance) -> Option<FocusedApplicationIdentity> {
        self.entries
            .iter()
            .find(|(instance, _)| *instance == front)
            .map(|(_, identity)| identity.clone())
    }

    fn remember(&mut self, front: ProcessInstance, identity: &FocusedApplicationIdentity) {
        // The full lookup can race a focus change; only bind what it read to
        // the process it was meant to describe.
        if identity.pid != front.pid {
            return;
        }
        self.entries
            .retain(|(instance, _)| instance.pid != front.pid);
        if self.entries.len() >= FRONTMOST_IDENTITY_MEMO_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back((front, identity.clone()));
    }
}

#[cfg(target_os = "macos")]
fn resolve_frontmost_identity(
    memo: &std::sync::Mutex<FrontmostIdentityMemo>,
    front: Option<ProcessInstance>,
    full_lookup: impl FnOnce() -> Option<FocusedApplicationIdentity>,
) -> Option<FocusedApplicationIdentity> {
    let Some(front) = front else {
        return full_lookup();
    };
    if let Some(identity) = memo.lock().ok().and_then(|memo| memo.lookup(front)) {
        return Some(identity);
    }
    let identity = full_lookup()?;
    if let Ok(mut memo) = memo.lock() {
        memo.remember(front, &identity);
    }
    Some(identity)
}

// Only the Process Manager reads these fields.
#[cfg(target_os = "macos")]
#[repr(C)]
struct ProcessSerialNumber {
    high: u32,
    low: u32,
}

#[cfg(target_os = "macos")]
type GetFrontProcessFn = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i16;
#[cfg(target_os = "macos")]
type GetProcessPidFn = unsafe extern "C" fn(*const ProcessSerialNumber, *mut libc::pid_t) -> i32;

/// The frontmost application's pid, read in-process. These Process Manager
/// calls are deprecated but still exported, and answer in well under a
/// millisecond where `lsappinfo` costs a process launch. They are resolved at
/// runtime so a macOS release that drops them falls back to `lsappinfo`.
#[cfg(target_os = "macos")]
fn frontmost_process_instance() -> Option<ProcessInstance> {
    static CALLS: std::sync::OnceLock<Option<(GetFrontProcessFn, GetProcessPidFn)>> =
        std::sync::OnceLock::new();
    let (front_process, process_pid) = (*CALLS.get_or_init(|| unsafe {
        let front = libc::dlsym(libc::RTLD_DEFAULT, c"GetFrontProcess".as_ptr());
        let pid = libc::dlsym(libc::RTLD_DEFAULT, c"GetProcessPID".as_ptr());
        (!front.is_null() && !pid.is_null()).then(|| {
            (
                std::mem::transmute::<*mut std::ffi::c_void, GetFrontProcessFn>(front),
                std::mem::transmute::<*mut std::ffi::c_void, GetProcessPidFn>(pid),
            )
        })
    }))?;
    let mut psn = ProcessSerialNumber { high: 0, low: 0 };
    if unsafe { front_process(&mut psn) } != 0 {
        return None;
    }
    let mut pid: libc::pid_t = 0;
    if unsafe { process_pid(&psn, &mut pid) } != 0 || pid <= 0 {
        return None;
    }
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    (written == size).then_some(ProcessInstance {
        pid,
        started: (info.pbi_start_tvsec, info.pbi_start_tvusec),
    })
}

/// The frontmost application, with its name and bundle id. The delivery path
/// asks for this a dozen times per dictation, so the LaunchServices read is
/// remembered per process instance; the pid itself is always read fresh.
#[cfg(target_os = "macos")]
pub(crate) fn frontmost_application_identity() -> Option<FocusedApplicationIdentity> {
    static MEMO: std::sync::Mutex<FrontmostIdentityMemo> =
        std::sync::Mutex::new(FrontmostIdentityMemo {
            entries: std::collections::VecDeque::new(),
        });
    resolve_frontmost_identity(
        &MEMO,
        frontmost_process_instance(),
        frontmost_application_identity_from_launch_services,
    )
}

#[cfg(target_os = "macos")]
fn frontmost_application_identity_from_launch_services() -> Option<FocusedApplicationIdentity> {
    // AppKit's changing application properties require its main run loop.
    // The sidecar runs Tokio, so NSWorkspace can retain the startup app.
    let asn = current_frontmost_app_asn()?;
    let output = std::process::Command::new("/usr/bin/lsappinfo")
        .args(["info", "-only", "name,bundleid,pid", &asn])
        .output()
        .ok()?;
    if !output.status.success() || current_frontmost_app_asn()? != asn {
        return None;
    }
    parse_lsappinfo_application_identity(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(all(test, target_os = "macos"))]
mod fresh_frontmost_identity_tests {
    use super::*;

    #[test]
    fn identity_binds_name_bundle_and_pid_from_one_application() {
        let output = "\"Safari\" ASN:0x0-0x1b01b: (in front)\n    bundleID=\"com.apple.Safari\"\n    pid = 756 !cgsConnection\n";
        let app = parse_lsappinfo_application_identity(output).unwrap();
        assert_eq!(app.pid, 756);
        assert_eq!(app.name.as_deref(), Some("Safari"));
        assert_eq!(app.bundle_id.as_deref(), Some("com.apple.Safari"));
        for invalid in [
            "",
            "\"Safari\"\n pid = 0",
            "\"Safari\"\n pid = -1",
            "\"Safari\"\n pid = missing",
        ] {
            assert!(parse_lsappinfo_application_identity(invalid).is_none());
        }
    }

    #[test]
    fn an_app_without_a_name_is_not_named_after_its_bundle_id() {
        let output = "[ NULL ]  ASN:0x0-0x1b01b: (in front)\n    bundleID=\"com.example.Helper\"\n    pid = 812 !cgsConnection\n";
        let app = parse_lsappinfo_application_identity(output).unwrap();
        assert_eq!(app.name, None);
        assert_eq!(app.bundle_id.as_deref(), Some("com.example.Helper"));

        let empty_name = "\"\" ASN:0x0-0x1b01b: (in front)\n    bundleID=\"com.example.Helper\"\n    pid = 812\n";
        let app = parse_lsappinfo_application_identity(empty_name).unwrap();
        assert_eq!(app.name, None);
    }

    #[test]
    fn only_an_app_that_was_brought_forward_waits_to_settle() {
        let started = std::time::Instant::now();
        TargetActivation::Unchanged.settle(std::time::Duration::from_millis(400));
        assert!(started.elapsed() < std::time::Duration::from_millis(100));

        let started = std::time::Instant::now();
        TargetActivation::Activated.settle(std::time::Duration::from_millis(30));
        assert!(started.elapsed() >= std::time::Duration::from_millis(30));
    }

    #[test]
    fn frontmost_name_and_bundle_id_agree_with_launch_services_and_stay_cheap() {
        // Needs a window server session. Starting a dictation reads the
        // frontmost name and bundle id; each used to cost two `lsappinfo`
        // launches.
        let Some(expected) = frontmost_application_identity_from_launch_services() else {
            return;
        };
        if frontmost_process_instance().map(|front| front.pid) != Some(expected.pid) {
            return;
        }
        let started = std::time::Instant::now();
        for _ in 0..16 {
            let name = crate::get_frontmost_app_name();
            let bundle_id = crate::get_frontmost_app_bundle_id();
            if frontmost_process_instance().map(|front| front.pid) != Some(expected.pid) {
                return;
            }
            assert_eq!(name, expected.name);
            assert_eq!(bundle_id, expected.bundle_id);
        }
        assert!(
            started.elapsed() < std::time::Duration::from_millis(60),
            "sixteen name and bundle id reads took {:?}",
            started.elapsed()
        );
    }

    fn identity(pid: i32, name: &str) -> FocusedApplicationIdentity {
        FocusedApplicationIdentity {
            pid,
            name: Some(name.to_string()),
            bundle_id: Some(format!("com.example.{name}")),
        }
    }

    fn instance(pid: i32, started: u64) -> ProcessInstance {
        ProcessInstance {
            pid,
            started: (started, 0),
        }
    }

    #[test]
    fn a_known_frontmost_process_skips_the_launch_services_read() {
        let memo = std::sync::Mutex::new(FrontmostIdentityMemo::default());
        let front = Some(instance(756, 1));
        let first = resolve_frontmost_identity(&memo, front, || Some(identity(756, "Notes")));
        assert_eq!(first, Some(identity(756, "Notes")));
        let again = resolve_frontmost_identity(&memo, front, || {
            panic!("a remembered process must not spawn lsappinfo again")
        });
        assert_eq!(again, first);
    }

    #[test]
    fn a_reused_pid_is_read_again() {
        let memo = std::sync::Mutex::new(FrontmostIdentityMemo::default());
        resolve_frontmost_identity(&memo, Some(instance(756, 1)), || {
            Some(identity(756, "Notes"))
        });
        let reused = resolve_frontmost_identity(&memo, Some(instance(756, 2)), || {
            Some(identity(756, "Safari"))
        });
        assert_eq!(reused, Some(identity(756, "Safari")));
        assert_eq!(memo.lock().unwrap().entries.len(), 1);
    }

    #[test]
    fn a_focus_change_during_the_full_read_is_not_remembered() {
        let memo = std::sync::Mutex::new(FrontmostIdentityMemo::default());
        let raced = resolve_frontmost_identity(&memo, Some(instance(756, 1)), || {
            Some(identity(900, "Safari"))
        });
        assert_eq!(raced, Some(identity(900, "Safari")));
        assert!(memo.lock().unwrap().entries.is_empty());
    }

    #[test]
    fn without_an_in_process_pid_every_call_reads_launch_services() {
        let memo = std::sync::Mutex::new(FrontmostIdentityMemo::default());
        let mut reads = 0;
        for _ in 0..3 {
            resolve_frontmost_identity(&memo, None, || {
                reads += 1;
                Some(identity(756, "Notes"))
            });
        }
        assert_eq!(reads, 3);
        assert_eq!(
            resolve_frontmost_identity(&memo, Some(instance(756, 1)), || None),
            None
        );
    }

    #[test]
    fn the_memo_stays_small() {
        let memo = std::sync::Mutex::new(FrontmostIdentityMemo::default());
        for pid in 1..=(FRONTMOST_IDENTITY_MEMO_CAPACITY as i32 + 4) {
            resolve_frontmost_identity(&memo, Some(instance(pid, 1)), || {
                Some(identity(pid, "App"))
            });
        }
        let memo = memo.lock().unwrap();
        assert_eq!(memo.entries.len(), FRONTMOST_IDENTITY_MEMO_CAPACITY);
        assert_eq!(
            memo.entries.back().map(|(instance, _)| instance.pid),
            Some(FRONTMOST_IDENTITY_MEMO_CAPACITY as i32 + 4)
        );
    }

    #[test]
    fn repeated_frontmost_reads_agree_with_launch_services_and_stay_cheap() {
        // Needs a window server session. The delivery path asks for the
        // frontmost application about sixteen times before it writes; each
        // `lsappinfo` read costs ~20 ms, which made up most of the gap between
        // stopping dictation and the words appearing.
        let Some(expected) = frontmost_application_identity_from_launch_services() else {
            return;
        };
        let Some(front) = frontmost_process_instance() else {
            return;
        };
        if front.pid != expected.pid {
            return;
        }
        assert_eq!(frontmost_application_identity(), Some(expected.clone()));
        let started = std::time::Instant::now();
        for _ in 0..16 {
            let current = frontmost_application_identity();
            if current.as_ref().map(|app| app.pid) != Some(expected.pid) {
                return;
            }
        }
        assert!(
            started.elapsed() < std::time::Duration::from_millis(60),
            "sixteen frontmost reads took {:?}",
            started.elapsed()
        );
    }
}

/// Copies the focused element from the current frontmost application. The
/// application identity is checked before and after the AX query so a focus
/// change cannot redirect a read or write to another process.
#[cfg(target_os = "macos")]
pub(crate) fn copy_frontmost_focused_accessibility_element(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<Option<AXUIElementRef>, String> {
    let Some(frontmost) = frontmost_application_identity() else {
        return Ok(None);
    };
    if !focused_application_matches_target(&frontmost, target_app, target_app_bundle_id) {
        return Err(
            "The frontmost application no longer matches the captured dictation target."
                .to_string(),
        );
    }

    let application = unsafe { AXUIElementCreateApplication(frontmost.pid) };
    if application.is_null() {
        return Err(
            "Accessibility could not create the frontmost application element.".to_string(),
        );
    }
    let focused_element = match ax_copy_attribute_value(application, "AXFocusedUIElement") {
        Ok(value) => value,
        Err(error) if is_ax_cannot_complete_error(&error) => None,
        Err(error) => {
            unsafe { CFRelease(application) };
            return Err(error);
        }
    };
    unsafe { CFRelease(application) };

    let Some(focused_element) = focused_element else {
        return Ok(None);
    };
    if ax_element_pid(focused_element) != Some(frontmost.pid) {
        unsafe { CFRelease(focused_element) };
        return Err(
            "The focused Accessibility element belongs to a different application.".to_string(),
        );
    }

    let frontmost_unchanged = frontmost_application_identity()
        .as_ref()
        .is_some_and(|current| focused_application_identity_unchanged(&frontmost, current));
    if !frontmost_unchanged {
        unsafe { CFRelease(focused_element) };
        return Err(
            "The frontmost application changed during the Accessibility lookup.".to_string(),
        );
    }

    Ok(Some(focused_element))
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_focused_element_still_matches_target(
    focused_element: AXUIElementRef,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    let Some(frontmost) = frontmost_application_identity() else {
        return Err("There is no frontmost application for Accessibility insertion.".to_string());
    };
    if !focused_application_matches_target(&frontmost, target_app, target_app_bundle_id)
        || ax_element_pid(focused_element) != Some(frontmost.pid)
    {
        return Err("The focused application changed before Accessibility insertion.".to_string());
    }
    let current = copy_frontmost_focused_accessibility_element(target_app, target_app_bundle_id)?
        .ok_or_else(|| {
        "The focused field changed before Accessibility insertion.".to_string()
    })?;
    let same_field = unsafe { core_foundation_sys::base::CFEqual(current, focused_element) } != 0;
    unsafe { CFRelease(current) };
    if !same_field {
        return Err("The focused field changed before Accessibility insertion.".to_string());
    }
    Ok(())
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
    let focused_element = copy_frontmost_focused_accessibility_element(None, None)
        .ok()
        .flatten();
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
    /// The captured target no longer owns focus. Do not redirect delivery.
    TargetChanged(String),
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
        paste_requested: false,
        successful_strategy: None,
        error: Some(dictation_secure_field::secure_field_refusal_message(signal)),
        secure_field: Some(signal),
    }
}

/// Some(true) means replacing AXValue could flatten different formatting runs.
/// None means the field does not expose enough formatting information.
#[cfg(target_os = "macos")]
fn ax_has_mixed_text_attributes(element: AXUIElementRef, text: &str) -> Option<bool> {
    let length = text.encode_utf16().count() as isize;
    if length == 0 {
        return Some(false);
    }
    let range = CFRange {
        location: 0,
        length,
    };
    let parameter = unsafe {
        AXValueCreate(
            AX_VALUE_CF_RANGE_TYPE,
            &range as *const CFRange as *const std::ffi::c_void,
        )
    };
    if parameter.is_null() {
        return None;
    }
    let attribute = ax_attribute("AXAttributedStringForRange");
    let mut value: CFTypeRef = std::ptr::null();
    let error = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element,
            attribute.as_concrete_TypeRef(),
            parameter,
            &mut value,
        )
    };
    unsafe { CFRelease(parameter) };
    if error != AX_ERROR_SUCCESS || value.is_null() {
        if !value.is_null() {
            unsafe { CFRelease(value) };
        }
        return None;
    }
    let result = cf_text_has_mixed_attributes(value, length);
    unsafe { CFRelease(value) };
    result
}

#[cfg(target_os = "macos")]
fn cf_text_has_mixed_attributes(value: CFTypeRef, length: isize) -> Option<bool> {
    use core_foundation_sys::attributed_string::{
        CFAttributedStringGetAttributes, CFAttributedStringGetLength, CFAttributedStringGetTypeID,
    };
    use core_foundation_sys::base::CFEqual;
    (|| {
        if unsafe { CFGetTypeID(value) != CFAttributedStringGetTypeID() } {
            return None;
        }
        let attributed = value as core_foundation_sys::attributed_string::CFAttributedStringRef;
        if unsafe { CFAttributedStringGetLength(attributed) } != length {
            return None;
        }
        let mut effective = CFRange {
            location: 0,
            length: 0,
        };
        let first = unsafe { CFAttributedStringGetAttributes(attributed, 0, &mut effective) };
        if first.is_null() {
            return None;
        }
        let mut index = effective.location.checked_add(effective.length)?;
        while index < length {
            if index <= 0 {
                return None;
            }
            let attributes =
                unsafe { CFAttributedStringGetAttributes(attributed, index, &mut effective) };
            if attributes.is_null() {
                return None;
            }
            if unsafe { CFEqual(first as CFTypeRef, attributes as CFTypeRef) } == 0 {
                return Some(true);
            }
            let next = effective.location.checked_add(effective.length)?;
            if next <= index {
                return None;
            }
            index = next;
        }
        Some(false)
    })()
}

#[cfg(all(test, target_os = "macos"))]
mod attributed_text_tests {
    use super::*;
    use core_foundation_sys::attributed_string::{
        CFAttributedStringCreateMutable, CFAttributedStringReplaceString,
        CFAttributedStringSetAttribute,
    };

    #[test]
    fn formatting_probe_handles_uniform_mixed_and_invalid_native_values() {
        let text = CFString::new("🧭 Before REPLACE after.");
        let key = CFString::new("AXFont");
        let bold = CFString::new("bold");
        let italic = CFString::new("italic");
        let value = unsafe { CFAttributedStringCreateMutable(std::ptr::null(), 0) };
        assert!(!value.is_null());
        unsafe {
            CFAttributedStringReplaceString(
                value,
                CFRange {
                    location: 0,
                    length: 0,
                },
                text.as_concrete_TypeRef(),
            );
        }
        assert_eq!(
            cf_text_has_mixed_attributes(value as CFTypeRef, 24),
            Some(false)
        );
        unsafe {
            CFAttributedStringSetAttribute(
                value,
                CFRange {
                    location: 0,
                    length: 24,
                },
                key.as_concrete_TypeRef(),
                bold.as_concrete_TypeRef() as CFTypeRef,
            );
        }
        assert_eq!(
            cf_text_has_mixed_attributes(value as CFTypeRef, 24),
            Some(false)
        );
        unsafe {
            CFAttributedStringSetAttribute(
                value,
                CFRange {
                    location: 18,
                    length: 6,
                },
                key.as_concrete_TypeRef(),
                italic.as_concrete_TypeRef() as CFTypeRef,
            );
        }
        assert_eq!(
            cf_text_has_mixed_attributes(value as CFTypeRef, 24),
            Some(true)
        );
        assert_eq!(cf_text_has_mixed_attributes(value as CFTypeRef, 23), None);
        assert_eq!(
            cf_text_has_mixed_attributes(text.as_concrete_TypeRef() as CFTypeRef, 24),
            None
        );
        unsafe {
            CFRelease(value as CFTypeRef);
        }
    }
}

#[cfg(target_os = "macos")]
fn insert_text_via_accessibility_owned(
    text: &str,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
    expected_field: Option<&DeliveryFieldFingerprint>,
    selection: Option<&PreparedDictationSelectedContext>,
    mut owned_edit: Option<&mut Option<AxOwnedDictationEdit>>,
) -> Result<bool, AccessibilityInsertFailure> {
    reactivate_target_application(target_app, target_app_bundle_id)
        .map_err(AccessibilityInsertFailure::TargetChanged)?
        .settle(std::time::Duration::from_millis(35));

    let focused_element = copy_frontmost_focused_accessibility_element(
        target_app,
        target_app_bundle_id,
    )
    .map_err(AccessibilityInsertFailure::TargetChanged)?
    .ok_or_else(|| {
        AccessibilityInsertFailure::Other(if check_accessibility_permission() {
            "Accessibility did not find a focused text element.".to_string()
        } else {
            "Accessibility did not find a focused text element. macOS may still have direct cursor insertion disabled for this app copy."
                .to_string()
        })
    })?;

    if let Err(error) = validate_delivery_field_identity(
        expected_field,
        delivery_fingerprint_from_element(focused_element).as_ref(),
    ) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::TargetChanged(error));
    }

    // Password boxes and other secure inputs are refused before anything is
    // written. This runs on the element already in hand, so the common path
    // pays two attribute reads and nothing else.
    if let Some(signal) = classify_focused_element_security(focused_element) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::SecureField(signal));
    }
    if let Err(error) = ensure_focused_element_still_matches_target(
        focused_element,
        target_app,
        target_app_bundle_id,
    ) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::TargetChanged(error));
    }

    let role = ax_copy_string_attribute(focused_element, "AXRole")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".to_string());

    let frontmost = frontmost_application_identity();
    let actual_identity_matches_element = frontmost
        .as_ref()
        .is_some_and(|app| ax_element_pid(focused_element) == Some(app.pid));
    let _focused_owner = UndoAxObject(focused_element);
    let enabled = ax_copy_boolean_attribute(focused_element, "AXEnabled")?;
    if actual_identity_matches_element
        && should_route_word_document_to_native_paste(
            frontmost.as_ref(),
            Some(role.as_str()),
            enabled,
            false,
        )
    {
        return Err(AccessibilityInsertFailure::Other(
            "Microsoft Word document fields require native paste.".to_string(),
        ));
    }

    // Read before writing so the expected field value is exact and a write
    // with an unknown result never causes an automatic duplicate paste.
    (|| -> Result<bool, AccessibilityInsertFailure> {
        let current_value = ax_copy_string_attribute(focused_element, "AXValue")?
            .ok_or_else(|| "The focused field cannot be read to verify insertion.".to_string())?;
        let selected_range = ax_copy_cf_range_attribute(focused_element, "AXSelectedTextRange")?
            .ok_or_else(|| "The focused field does not expose its text selection.".to_string())?;
        let (next_value, next_range) = replace_utf16_range(&current_value, selected_range, text)
            .ok_or_else(|| "The focused field reported an invalid text selection.".to_string())?;
        let formatting = ax_has_mixed_text_attributes(focused_element, &current_value);
        if formatting == Some(true) {
            return Err(
                "The focused field has mixed formatting; use selection-preserving paste."
                    .to_string()
                    .into(),
            );
        }
        let value_settable = ax_is_attribute_settable(focused_element, "AXValue")?
            && (formatting == Some(false) || role == "AXTextField");
        let selected_text_settable = ax_is_attribute_settable(focused_element, "AXSelectedText")?;
        ensure_focused_element_still_matches_target(
            focused_element,
            target_app,
            target_app_bundle_id,
        )
        .map_err(AccessibilityInsertFailure::TargetChanged)?;
        if selection.is_some_and(|guard| !guard.verify_original_selection()) {
            return Err(AccessibilityInsertFailure::TargetChanged(
                DICTATION_FOCUS_CHANGED_MESSAGE.into(),
            ));
        }
        let mut inline = owned_edit
            .as_ref()
            .filter(|_| selected_text_settable)
            .filter(|_| {
                ax_is_attribute_settable(focused_element, "AXSelectedTextRange").unwrap_or(false)
            })
            .and_then(|_| {
                inline_edit::InlineInsertion::capture(
                    &current_value,
                    undo_range(selected_range)?,
                    text,
                    &next_value,
                    undo_range(next_range)?,
                )
            });
        let history = owned_edit
            .as_ref()
            .filter(|_| selected_text_settable)
            .filter(|_| {
                ax_is_attribute_settable(focused_element, "AXSelectedTextRange").unwrap_or(false)
            })
            .filter(|_| {
                current_value.encode_utf16().count() <= inline_edit::MAX_UTF16
                    && next_value.encode_utf16().count() <= inline_edit::MAX_UTF16
            })
            .and_then(|_| {
                voice_edit::History::inserted(
                    voice_edit::Image {
                        text: current_value.clone(),
                        selection: undo_range(selected_range)?,
                    },
                    text,
                    voice_edit::Image {
                        text: next_value.clone(),
                        selection: undo_range(next_range)?,
                    },
                )
            });
        let mut history = history;
        let eligible = history.is_some();
        if eligible {
            if ax_set_string_attribute(focused_element, "AXSelectedText", text).is_err() {
                return Ok(false);
            }
        } else if value_settable {
            if ax_set_string_attribute(focused_element, "AXValue", &next_value).is_err() {
                return Ok(false);
            }
        } else if selected_text_settable {
            if ax_set_string_attribute(focused_element, "AXSelectedText", text).is_err() {
                return Ok(false);
            }
        } else {
            return Err(format!(
                "Focused '{}' field does not support Accessibility text writes.",
                role
            )
            .into());
        }
        // From here a write was accepted. Any uncertainty stops this attempt,
        // rather than issuing another write that might duplicate the text.
        for _ in 0..6 {
            if ensure_focused_element_still_matches_target(
                focused_element,
                target_app,
                target_app_bundle_id,
            )
            .is_err()
            {
                return Ok(false);
            }
            if ax_copy_string_attribute(focused_element, "AXValue")
                .ok()
                .flatten()
                .as_deref()
                == Some(next_value.as_str())
            {
                if !eligible
                    && ax_is_attribute_settable(focused_element, "AXSelectedTextRange")
                        .unwrap_or(false)
                {
                    let _ = ax_set_cf_range_attribute(
                        focused_element,
                        "AXSelectedTextRange",
                        next_range,
                    );
                }
                if eligible {
                    if let (Some(slot), Some(fingerprint), Some(post), Some(history)) = (
                        owned_edit.as_deref_mut(),
                        delivery_fingerprint_from_element(focused_element),
                        ax_copy_cf_range_attribute(focused_element, "AXSelectedTextRange")
                            .ok()
                            .flatten(),
                        history.take(),
                    ) {
                        if undo_range(post) == undo_range(next_range) {
                            unsafe {
                                core_foundation_sys::base::CFRetain(focused_element);
                            }
                            *slot = Some(AxOwnedDictationEdit {
                                field: AxRetainedField(UndoAxObject(focused_element)),
                                fingerprint,
                                policy: inline.take(),
                                history,
                                poisoned: false,
                            });
                        }
                    }
                }
                return Ok(true);
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        Ok(false)
    })()
}

/// Reactivates `target_app`/`target_app_bundle_id` (if needed) and copies the
/// frontmost application's `AXFocusedUIElement`, mirroring the focused-element lookup
/// that `insert_text_via_accessibility` performs inline. Factored out so the
/// selected-text-transform focused-field capture/replace helpers below can
/// share it without duplicating the reactivate and identity checks.
///
/// Returns `Ok(None)` (rather than an error) when accessibility is reachable
/// but no element currently has focus, so callers can fall back to another
/// capture strategy instead of surfacing a hard error.
#[cfg(target_os = "macos")]
pub(crate) fn copy_focused_accessibility_element(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
    _system_wide_error: String,
) -> Result<Option<AXUIElementRef>, String> {
    reactivate_target_application(target_app, target_app_bundle_id)?
        .settle(std::time::Duration::from_millis(35));
    copy_frontmost_focused_accessibility_element(target_app, target_app_bundle_id)
}

/// The few characters right before and after an empty caret in the focused
/// field, for `text::cursor_fit`. `None` when there is no readable text
/// field, when text is selected (the dictation replaces it), or when the
/// field is secure. Read in-process and never stored or logged.
#[cfg(target_os = "macos")]
/// The few characters around the caret, plus capitalized names already in
/// the field (an email being answered, a doc being edited). Read for this
/// insertion only and never stored.
pub(crate) fn read_cursor_neighbors(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Option<(String, String, Vec<String>)> {
    let focused_element = copy_focused_accessibility_element(
        target_app,
        target_app_bundle_id,
        "Accessibility could not create the system-wide element.".to_string(),
    )
    .ok()
    .flatten()?;
    let neighbors = (|| {
        if classify_focused_element_security(focused_element).is_some() {
            return None;
        }
        let value = ax_copy_string_attribute(focused_element, "AXValue")
            .ok()
            .flatten()?;
        let range = ax_copy_cf_range_attribute(focused_element, "AXSelectedTextRange")
            .ok()
            .flatten()?;
        if range.length != 0 || range.location < 0 {
            return None;
        }
        let units: Vec<u16> = value.encode_utf16().collect();
        let caret = usize::try_from(range.location).ok()?.min(units.len());
        let before = String::from_utf16_lossy(&units[caret.saturating_sub(8)..caret]);
        let after = String::from_utf16_lossy(&units[caret..(caret + 2).min(units.len())]);
        Some((before, after, names_in_field(&value)))
    })();
    unsafe { CFRelease(focused_element) };
    neighbors
}

/// Capitalized words of five or more letters from the first 20,000
/// characters of a field, at most 100, for sound-alike name matching.
pub(crate) fn names_in_field(value: &str) -> Vec<String> {
    const MAX_CHARS: usize = 20_000;
    const MAX_NAMES: usize = 100;
    let mut names: Vec<String> = Vec::new();
    let scanned: String = value.chars().take(MAX_CHARS).collect();
    for word in scanned.split(|ch: char| !ch.is_alphabetic()) {
        if names.len() >= MAX_NAMES {
            break;
        }
        let starts_upper = word.chars().next().is_some_and(char::is_uppercase);
        let rest_lower = word.chars().skip(1).any(char::is_lowercase);
        if starts_upper
            && rest_lower
            && word.chars().count() >= 5
            && !names.iter().any(|name| name == word)
            && !crate::dictation_sounds_like::is_common_word(word)
        {
            names.push(word.to_string());
        }
    }
    names
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

#[cfg(target_os = "macos")]
fn delivery_fingerprint_from_element(element: AXUIElementRef) -> Option<DeliveryFieldFingerprint> {
    let fingerprint = DeliveryFieldFingerprint {
        pid: ax_element_pid(element),
        element_hash: Some(unsafe { core_foundation_sys::base::CFHash(element) } as u64),
        role: ax_copy_string_attribute(element, "AXRole").ok().flatten(),
        identifier: ax_copy_string_attribute(element, "AXIdentifier")
            .ok()
            .flatten(),
        frame: ax_element_frame(element),
        app_bundle_id: get_frontmost_app_bundle_id(),
        app_name: get_frontmost_app_name(),
    };
    fingerprint.usable().then_some(fingerprint)
}

/// Capture the focused control without activating an app, prompting for
/// Accessibility, or reading AXValue. Unknown/unusable identity is `None` and
/// preserves the existing app-level delivery behavior.
#[cfg(target_os = "macos")]
pub(crate) fn capture_focused_field_fingerprint_without_activation(
) -> Option<DeliveryFieldFingerprint> {
    if !check_accessibility_permission() {
        return None;
    }
    let element = copy_frontmost_focused_accessibility_element(None, None)
        .ok()
        .flatten()?;
    let fingerprint = if classify_focused_element_security(element).is_none() {
        delivery_fingerprint_from_element(element)
    } else {
        None
    };
    unsafe { CFRelease(element) };
    fingerprint
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_focused_field_fingerprint_without_activation(
) -> Option<DeliveryFieldFingerprint> {
    None
}

#[cfg(any(target_os = "macos", test))]
pub(crate) use selected_context_read::{
    prepare_session_selection_watch, PreparedDictationSelectedContext,
};

#[cfg(any(target_os = "macos", test))]
mod selected_context_read {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};

    const PREPARE_WINDOW: Duration = Duration::from_millis(100);
    const READ_WINDOW: Duration = Duration::from_millis(500);
    #[cfg(test)]
    const WATCH_LIFETIME: Duration = Duration::from_secs(15);
    const MAX_SELECTED_CHARS: usize = 4_000;

    enum WatchRequest {
        Flush(mpsc::SyncSender<()>),
        Verify(mpsc::SyncSender<bool>, Instant),
        Read(mpsc::SyncSender<Option<String>>, Instant),
    }

    struct FocusGuardState {
        invalidated: AtomicBool,
        stopped: AtomicBool,
        read_started: AtomicBool,
        deadline: Mutex<Option<Instant>>,
        watching_since: Instant,
        lifetime: Duration,
        selection_range: Mutex<Option<(isize, isize)>>,
        explicit_snapshot: AtomicBool,
        original_text: Mutex<Option<String>>,
    }

    impl FocusGuardState {
        fn valid_at(&self, now: Instant) -> bool {
            !self.invalidated.load(Ordering::Acquire)
                && !self.stopped.load(Ordering::Acquire)
                && now.saturating_duration_since(self.watching_since) < self.lifetime
                && self
                    .deadline
                    .lock()
                    .is_ok_and(|deadline| deadline.is_none_or(|end| now < end))
        }

        fn permits_plaintext_read(&self) -> bool {
            self.valid_at(Instant::now()) && self.explicit_snapshot.load(Ordering::Acquire)
        }

        fn invalidate(&self) {
            self.invalidated.store(true, Ordering::Release);
        }
    }

    /// No AX objects cross threads. The observer keeps running until this guard
    /// is dropped, including while the caller acquires its session commit locks.
    pub(crate) struct PreparedDictationSelectedContext {
        expected: DeliveryFieldFingerprint,
        state: Arc<FocusGuardState>,
        flush: mpsc::Sender<WatchRequest>,
    }

    impl std::fmt::Debug for PreparedDictationSelectedContext {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("PreparedDictationSelectedContext")
        }
    }

    impl PreparedDictationSelectedContext {
        pub(crate) fn use_explicit_snapshot(&self) {
            self.state.explicit_snapshot.store(true, Ordering::Release);
        }

        pub(crate) fn invalidate(&self) {
            self.state.invalidate();
        }

        #[cfg(target_os = "macos")]
        pub(crate) fn verify_original_selection(&self) -> bool {
            let end = Instant::now() + READ_WINDOW;
            let (reply, receiver) = mpsc::sync_channel(1);
            let valid = self.is_valid()
                && self.flush.send(WatchRequest::Verify(reply, end)).is_ok()
                && end
                    .checked_duration_since(Instant::now())
                    .is_some_and(|remaining| receiver.recv_timeout(remaining).ok() == Some(true))
                && self.is_valid();
            if !valid {
                self.invalidate();
            }
            valid
        }

        /// This checks delivered notifications and deadline state only. It
        /// cannot prove that an OS notification still in transit has arrived.
        pub(crate) fn is_valid(&self) -> bool {
            self.state.valid_at(Instant::now())
        }

        #[cfg(target_os = "macos")]
        pub(crate) fn read_selected_text(&self) -> Option<String> {
            self.read_with_backend(
                |_, _| self.is_valid().then_some(()),
                |_, end| {
                    let (reply, receiver) = mpsc::sync_channel(1);
                    self.flush.send(WatchRequest::Read(reply, end)).ok()?;
                    let remaining = end.checked_duration_since(Instant::now())?;
                    receiver.recv_timeout(remaining).ok().flatten()
                },
                |end| {
                    let (reply, receiver) = mpsc::sync_channel(1);
                    self.flush.send(WatchRequest::Flush(reply)).is_ok()
                        && end
                            .checked_duration_since(Instant::now())
                            .is_some_and(|remaining| receiver.recv_timeout(remaining).is_ok())
                },
            )
        }

        // Keep ordering and one-read ownership shared with the native reader.
        fn read_with_backend<Element>(
            &self,
            mut focused: impl FnMut(&DeliveryFieldFingerprint, Instant) -> Option<Element>,
            read: impl FnOnce(&Element, Instant) -> Option<String>,
            flush: impl FnOnce(Instant) -> bool,
        ) -> Option<String> {
            if !self.state.permits_plaintext_read()
                || self.state.read_started.swap(true, Ordering::AcqRel)
            {
                return None;
            }
            let end = Instant::now() + READ_WINDOW;
            *self.state.deadline.lock().ok()? = Some(end);
            let element = focused(&self.expected, end)?;
            let result = read_selection_with_checks(
                || self.is_valid(),
                || read(&element, end),
                || focused(&self.expected, end).is_some() && flush(end) && self.is_valid(),
            );
            *self.state.deadline.lock().ok()? = None;
            if self.state.explicit_snapshot.load(Ordering::Acquire) {
                *self.state.original_text.lock().ok()? = result.clone();
            }
            if result.is_none() {
                self.invalidate();
            }
            result
        }

        #[cfg(not(target_os = "macos"))]
        pub(crate) fn read_selected_text(&self) -> Option<String> {
            None
        }
    }

    impl Drop for PreparedDictationSelectedContext {
        fn drop(&mut self) {
            self.state.stopped.store(true, Ordering::Release);
            // Never join: the observer owns its bounded native cleanup.
        }
    }

    fn read_selection_with_checks(
        before: impl FnOnce() -> bool,
        read: impl FnOnce() -> Option<String>,
        after: impl FnOnce() -> bool,
    ) -> Option<String> {
        if !before() {
            return None;
        }
        let text = read()?;
        after().then_some(text)
    }

    fn bounded_selection(text: &str) -> Option<String> {
        (text.chars().count() <= MAX_SELECTED_CHARS && !text.trim().is_empty())
            .then(|| text.to_string())
    }

    fn matches_original_range(
        expected: Option<(isize, isize)>,
        current: Option<(isize, isize)>,
    ) -> bool {
        expected.is_some() && expected == current
    }

    fn matches_original_element(expected: &DeliveryFieldFingerprint, pid: i32, hash: u64) -> bool {
        expected.usable() && expected.pid == Some(pid) && expected.element_hash == Some(hash)
    }

    #[cfg(target_os = "macos")]
    static OBSERVER_ACTIVE: AtomicBool = AtomicBool::new(false);

    #[cfg(target_os = "macos")]
    struct ObserverSlot;
    #[cfg(target_os = "macos")]
    impl Drop for ObserverSlot {
        fn drop(&mut self) {
            OBSERVER_ACTIVE.store(false, Ordering::Release);
        }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn prepare_session_selection_watch(
        expected: &DeliveryFieldFingerprint,
        target_app: Option<&str>,
        target_bundle_id: Option<&str>,
        lifetime: Duration,
    ) -> Option<PreparedDictationSelectedContext> {
        prepare_watch(expected, target_app, target_bundle_id, lifetime)
    }

    #[cfg(not(target_os = "macos"))]
    pub(crate) fn prepare_session_selection_watch(
        _expected: &DeliveryFieldFingerprint,
        _target_app: Option<&str>,
        _target_bundle_id: Option<&str>,
        _lifetime: Duration,
    ) -> Option<PreparedDictationSelectedContext> {
        None
    }

    #[cfg(target_os = "macos")]
    fn prepare_watch(
        expected: &DeliveryFieldFingerprint,
        target_app: Option<&str>,
        target_bundle_id: Option<&str>,
        lifetime: Duration,
    ) -> Option<PreparedDictationSelectedContext> {
        if !expected.usable()
            || expected.element_hash.is_none()
            || !check_accessibility_permission()
            || target_app.is_some_and(|app| expected.app_name.as_deref() != Some(app))
            || target_bundle_id
                .is_some_and(|bundle| expected.app_bundle_id.as_deref() != Some(bundle))
            || OBSERVER_ACTIVE
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return None;
        }
        let started = Instant::now();
        let state = Arc::new(FocusGuardState {
            invalidated: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            read_started: AtomicBool::new(false),
            deadline: Mutex::new(None),
            watching_since: started,
            lifetime,
            selection_range: Mutex::new(None),
            explicit_snapshot: AtomicBool::new(false),
            original_text: Mutex::new(None),
        });
        let (ready, receiver) = mpsc::sync_channel(1);
        let (flush, requests) = mpsc::channel();
        let worker_state = Arc::clone(&state);
        let worker_expected = expected.clone();
        let worker = std::thread::Builder::new()
            .name("dictation-context-focus".into())
            .spawn(move || {
                let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
                let _slot = ObserverSlot;
                observe_focus(
                    worker_expected,
                    Arc::clone(&worker_state),
                    ready,
                    requests,
                    started + PREPARE_WINDOW,
                );
                worker_state.invalidate();
                worker_state.stopped.store(true, Ordering::Release);
            });
        if worker.is_err() {
            OBSERVER_ACTIVE.store(false, Ordering::Release);
            return None;
        }
        if receiver
            .recv_timeout(PREPARE_WINDOW.saturating_sub(started.elapsed()))
            .ok()
            != Some(true)
            || !state.valid_at(Instant::now())
        {
            state.stopped.store(true, Ordering::Release);
            return None;
        }
        Some(PreparedDictationSelectedContext {
            expected: expected.clone(),
            state,
            flush,
        })
    }

    #[cfg(target_os = "macos")]
    pub(super) struct AxObject(pub(super) CFTypeRef);
    #[cfg(target_os = "macos")]
    impl Drop for AxObject {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CFRelease(self.0);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn messaging_timeout(element: AXUIElementRef, end: Instant) -> bool {
        let Some(remaining) = end.checked_duration_since(Instant::now()) else {
            return false;
        };
        !remaining.is_zero()
            && unsafe {
                AXUIElementSetMessagingTimeout(
                    element,
                    remaining.min(Duration::from_millis(20)).as_secs_f32(),
                ) == AX_ERROR_SUCCESS
            }
    }

    #[cfg(target_os = "macos")]
    fn copy_attribute(element: AXUIElementRef, attribute: &str, end: Instant) -> Option<AxObject> {
        if !messaging_timeout(element, end) {
            return None;
        }
        let value = ax_copy_attribute_value(element, attribute)
            .ok()
            .flatten()
            .map(AxObject)?;
        (Instant::now() < end).then_some(value)
    }

    #[cfg(target_os = "macos")]
    fn bounded_string(value: CFTypeRef) -> Option<String> {
        use core_foundation_sys::string::{CFStringGetCharacters, CFStringGetLength};
        if unsafe { CFGetTypeID(value) != CFStringGetTypeID() } {
            return None;
        }
        let length = unsafe { CFStringGetLength(value.cast()) };
        if length <= 0 {
            return None;
        }
        if length as usize > MAX_SELECTED_CHARS * 2 {
            return None;
        }
        let count = length as usize;
        let mut units = vec![0_u16; count];
        unsafe {
            CFStringGetCharacters(
                value.cast(),
                CFRange {
                    location: 0,
                    length: count as isize,
                },
                units.as_mut_ptr(),
            );
        }
        bounded_selection(&String::from_utf16(&units).ok()?)
    }

    #[cfg(target_os = "macos")]
    fn selection_range(element: &AxObject, end: Instant) -> Option<(isize, isize)> {
        if !messaging_timeout(element.0, end) {
            return None;
        }
        let range = ax_copy_cf_range_attribute(element.0, "AXSelectedTextRange").ok()??;
        (Instant::now() < end && range.location >= 0 && range.length > 0)
            .then_some((range.location, range.length))
    }

    #[cfg(target_os = "macos")]
    fn focused_element(expected: &DeliveryFieldFingerprint, end: Instant) -> Option<AxObject> {
        if !check_accessibility_permission() || secure_event_input_enabled() {
            return None;
        }
        let app = AxObject(unsafe { AXUIElementCreateApplication(expected.pid?) });
        if app.0.is_null()
            || !messaging_timeout(app.0, end)
            || ax_element_pid(app.0) != expected.pid
        {
            return None;
        }
        // Setting timeout on a system-wide object changes the process-wide
        // default. Use only this original application's local object instead.
        let frontmost = copy_attribute(app.0, "AXFrontmost", end)?;
        if unsafe {
            CFGetTypeID(frontmost.0) != CFBoolean::type_id()
                || !core_foundation_sys::number::CFBooleanGetValue(frontmost.0.cast())
        } {
            return None;
        }
        let focused = copy_attribute(app.0, "AXFocusedUIElement", end)?;
        if !messaging_timeout(focused.0, end) {
            return None;
        }
        let pid = ax_element_pid(focused.0)?;
        let hash = unsafe { core_foundation_sys::base::CFHash(focused.0) } as u64;
        if !matches_original_element(expected, pid, hash) {
            return None;
        }
        if let Some(identifier) = expected.identifier.as_deref() {
            let current = bounded_string(copy_attribute(focused.0, "AXIdentifier", end)?.0)?;
            if current != identifier {
                return None;
            }
        }
        // Attribute errors fail closed; unsupported subrole is allowed only
        // after the role itself was read successfully.
        let role = bounded_string(copy_attribute(focused.0, "AXRole", end)?.0)?;
        let subrole = if messaging_timeout(focused.0, end) {
            ax_copy_attribute_value(focused.0, "AXSubrole")
                .ok()?
                .map(AxObject)
                .and_then(|value| bounded_string(value.0))
        } else {
            return None;
        };
        if Instant::now() >= end
            || expected.role.as_deref() != Some(role.as_str())
            || dictation_secure_field::classify_secure_field(
                Some(&role),
                subrole.as_deref(),
                secure_event_input_enabled(),
            )
            .is_some()
        {
            return None;
        }
        Some(focused)
    }

    #[cfg(target_os = "macos")]
    extern "C" fn focus_changed(
        _observer: CFTypeRef,
        _element: AXUIElementRef,
        _notification: CFStringRef,
        context: *mut std::ffi::c_void,
    ) {
        if !context.is_null() {
            // The worker retains this Arc until the observer and source are removed.
            unsafe {
                (&*context.cast::<FocusGuardState>()).invalidate();
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn drain_focus_notifications() -> bool {
        use core_foundation_sys::runloop::{
            kCFRunLoopDefaultMode, kCFRunLoopRunHandledSource, kCFRunLoopRunTimedOut,
            CFRunLoopRunInMode,
        };
        for _ in 0..32 {
            let status = unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, 1) };
            if status == kCFRunLoopRunTimedOut {
                return true;
            }
            if status != kCFRunLoopRunHandledSource {
                return false;
            }
        }
        false
    }

    #[cfg(target_os = "macos")]
    fn verify_metadata(
        expected: &DeliveryFieldFingerprint,
        state: &FocusGuardState,
        original: Option<&AxObject>,
        end: Instant,
    ) -> bool {
        state.valid_at(Instant::now())
            && focused_element(expected, end).is_some_and(|focused| {
                original.is_none_or(|original| {
                    let expected = state.selection_range.lock().ok().and_then(|range| *range);
                    matches_original_range(expected, selection_range(original, end))
                        && matches_original_range(expected, selection_range(&focused, end))
                })
            })
    }

    #[cfg(target_os = "macos")]
    struct Notifications {
        observer: CFTypeRef,
        entries: Vec<(AxObject, CFString)>,
    }

    #[cfg(target_os = "macos")]
    impl Notifications {
        fn add(
            &mut self,
            element: AXUIElementRef,
            name: &str,
            context: *mut std::ffi::c_void,
            end: Instant,
        ) -> bool {
            let notification = CFString::new(name);
            if !messaging_timeout(element, end)
                || unsafe {
                    AXObserverAddNotification(
                        self.observer,
                        element,
                        notification.as_concrete_TypeRef(),
                        context,
                    )
                } != AX_ERROR_SUCCESS
            {
                return false;
            }
            let retained = unsafe { core_foundation_sys::base::CFRetain(element) };
            self.entries.push((AxObject(retained), notification));
            true
        }
    }

    #[cfg(target_os = "macos")]
    impl Drop for Notifications {
        fn drop(&mut self) {
            for (element, notification) in &self.entries {
                unsafe {
                    AXObserverRemoveNotification(
                        self.observer,
                        element.0,
                        notification.as_concrete_TypeRef(),
                    );
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn observe_focus(
        expected: DeliveryFieldFingerprint,
        state: Arc<FocusGuardState>,
        ready: mpsc::SyncSender<bool>,
        requests: mpsc::Receiver<WatchRequest>,
        end: Instant,
    ) {
        use core_foundation_sys::runloop::{
            kCFRunLoopDefaultMode, kCFRunLoopRunHandledSource, kCFRunLoopRunTimedOut,
            CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRemoveSource, CFRunLoopRunInMode,
        };
        let Some(pid) = expected.pid else {
            return;
        };
        let app = AxObject(unsafe { AXUIElementCreateApplication(pid) });
        if app.0.is_null() || !messaging_timeout(app.0, end) {
            return;
        }
        let mut raw_observer: CFTypeRef = std::ptr::null();
        if unsafe { AXObserverCreate(pid, focus_changed, &mut raw_observer) } != AX_ERROR_SUCCESS
            || raw_observer.is_null()
        {
            return;
        }
        let observer = AxObject(raw_observer);
        let context = Arc::as_ptr(&state).cast_mut().cast::<std::ffi::c_void>();
        let mut notifications = Notifications {
            observer: observer.0,
            entries: Vec::new(),
        };
        for name in ["AXFocusedUIElementChanged", "AXApplicationDeactivated"] {
            if !notifications.add(app.0, name, context, end) {
                return;
            }
        }
        let selection_element = {
            let Some(element) = focused_element(&expected, end) else {
                return;
            };
            for name in ["AXSelectedTextChanged", "AXValueChanged"] {
                if !notifications.add(element.0, name, context, end) {
                    return;
                }
            }
            let Some(range) = selection_range(&element, end) else {
                return;
            };
            if let Ok(mut original) = state.selection_range.lock() {
                *original = Some(range);
            }
            Some(element)
        };
        let source = unsafe { AXObserverGetRunLoopSource(observer.0) };
        if source.is_null() {
            return;
        }
        let run_loop = unsafe { CFRunLoopGetCurrent() };
        unsafe {
            CFRunLoopAddSource(run_loop, source, kCFRunLoopDefaultMode);
        }
        let healthy = focused_element(&expected, end).is_some_and(|element| {
            selection_element.as_ref().is_none_or(|_| {
                let expected = state.selection_range.lock().ok().and_then(|range| *range);
                selection_range(&element, end) == expected
            })
        }) && drain_focus_notifications()
            && state.valid_at(Instant::now());
        if healthy {
            let _ = ready.send(true);
        }
        while healthy && state.valid_at(Instant::now()) {
            let status = unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, 1) };
            if ![kCFRunLoopRunHandledSource, kCFRunLoopRunTimedOut].contains(&status) {
                state.invalidate();
                break;
            }
            while let Ok(request) = requests.try_recv() {
                if !drain_focus_notifications() {
                    state.invalidate();
                }
                match request {
                    WatchRequest::Flush(reply) => {
                        let _ = reply.send(());
                    }
                    WatchRequest::Verify(reply, end) => {
                        let valid =
                            verify_metadata(&expected, &state, selection_element.as_ref(), end)
                                && (!state.explicit_snapshot.load(Ordering::Acquire)
                                    || selection_element.as_ref().is_some_and(|original| {
                                        state.original_text.lock().ok().is_some_and(|snapshot| {
                                            snapshot.as_ref().is_some_and(|snapshot| {
                                                copy_attribute(original.0, "AXSelectedText", end)
                                                    .and_then(|value| bounded_string(value.0))
                                                    .as_ref()
                                                    == Some(snapshot)
                                            })
                                        })
                                    }))
                                && drain_focus_notifications()
                                && state.valid_at(Instant::now());
                        if !valid {
                            state.invalidate();
                        }
                        let _ = reply.send(valid);
                    }
                    WatchRequest::Read(reply, end) => {
                        let text = read_selection_with_checks(
                            || verify_metadata(&expected, &state, selection_element.as_ref(), end),
                            || {
                                let element = selection_element.as_ref()?;
                                if !state.permits_plaintext_read() {
                                    return None;
                                }
                                copy_attribute(element.0, "AXSelectedText", end)
                                    .and_then(|value| bounded_string(value.0))
                            },
                            || {
                                verify_metadata(&expected, &state, selection_element.as_ref(), end)
                                    && drain_focus_notifications()
                                    && state.valid_at(Instant::now())
                            },
                        );
                        if text.is_none() {
                            state.invalidate();
                        }
                        let _ = reply.send(text);
                    }
                }
            }
        }
        state.invalidate();
        unsafe {
            CFRunLoopRemoveSource(run_loop, source, kCFRunLoopDefaultMode);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn state() -> FocusGuardState {
            FocusGuardState {
                invalidated: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
                read_started: AtomicBool::new(false),
                deadline: Mutex::new(None),
                watching_since: Instant::now(),
                lifetime: WATCH_LIFETIME,
                selection_range: Mutex::new(None),
                explicit_snapshot: AtomicBool::new(false),
                original_text: Mutex::new(None),
            }
        }

        fn prepared() -> PreparedDictationSelectedContext {
            let (flush, _) = mpsc::channel();
            let guard = PreparedDictationSelectedContext {
                expected: DeliveryFieldFingerprint {
                    pid: Some(42),
                    element_hash: Some(7),
                    ..Default::default()
                },
                state: Arc::new(state()),
                flush,
            };
            guard.use_explicit_snapshot();
            guard
        }

        #[test]
        fn unqualified_session_watch_refuses_plaintext_until_explicit_consent() {
            let mut state = state();
            assert!(!state.permits_plaintext_read());
            state.lifetime = Duration::from_secs(900);
            assert!(!state.permits_plaintext_read());
            state.explicit_snapshot.store(true, Ordering::Release);
            assert!(state.permits_plaintext_read());
            state.invalidate();
            assert!(!state.permits_plaintext_read());
        }

        #[test]
        fn command_selection_reader_rejects_foreign_field_before_any_text_read() {
            let guard = prepared();
            let result = guard.read_with_backend(
                |expected, _| matches_original_element(expected, 42, 8).then_some(8),
                |_, _| panic!("foreign field must never be read"),
                |_| panic!("refused read must not flush"),
            );
            assert_eq!(result, None);
        }

        #[test]
        fn command_selection_reader_discards_text_when_focus_changes_during_read() {
            use std::cell::Cell;
            let guard = prepared();
            let hash = Cell::new(7);
            let reads = Cell::new(0);
            let result = guard.read_with_backend(
                |expected, _| {
                    matches_original_element(expected, 42, hash.get()).then_some(hash.get())
                },
                |element, _| {
                    assert_eq!(*element, 7);
                    reads.set(reads.get() + 1);
                    hash.set(8);
                    Some("original selection".into())
                },
                |_| panic!("changed focus must refuse before flush"),
            );
            assert_eq!(reads.get(), 1);
            assert_eq!(result, None);
        }

        #[test]
        fn command_selection_reader_checks_notifications_and_allows_only_one_read() {
            for invalidate in [false, true] {
                let guard = prepared();
                let result = guard.read_with_backend(
                    |expected, _| matches_original_element(expected, 42, 7).then_some(7),
                    |_, _| Some("original selection".into()),
                    |_| {
                        if invalidate {
                            guard.state.invalidate();
                        }
                        true
                    },
                );
                assert_eq!(
                    result.as_deref(),
                    (!invalidate).then_some("original selection")
                );
                assert_eq!(guard.is_valid(), !invalidate);
                assert_eq!(
                    guard.read_with_backend(
                        |_, _| panic!("second read must not query focus"),
                        |_: &u64, _| panic!("second read must not query text"),
                        |_| panic!("second read must not flush"),
                    ),
                    None
                );
            }
        }

        #[test]
        fn command_selection_reader_keeps_guard_until_dispatch_boundary() {
            let guard = prepared();
            assert_eq!(
                guard
                    .read_with_backend(
                        |expected, _| matches_original_element(expected, 42, 7).then_some(7),
                        |_, _| Some("original selection".into()),
                        |_| true,
                    )
                    .as_deref(),
                Some("original selection")
            );
            guard.state.invalidate();
            assert!(!guard.is_valid());
        }

        #[test]
        fn selected_context_guard_invalidation_survives_away_and_back() {
            let guard = state();
            assert!(guard.valid_at(Instant::now()));
            guard.invalidate();
            assert!(!guard.valid_at(Instant::now()));
            // Returning to the original fingerprint never clears invalidation.
            assert!(!guard.valid_at(Instant::now()));
        }

        #[test]
        fn selected_context_guard_requires_original_pid_and_element_hash() {
            let expected = DeliveryFieldFingerprint {
                pid: Some(42),
                element_hash: Some(7),
                ..Default::default()
            };
            assert!(matches_original_element(&expected, 42, 7));
            assert!(!matches_original_element(&expected, 43, 7));
            assert!(!matches_original_element(&expected, 42, 8));
            assert!(!matches_original_element(
                &DeliveryFieldFingerprint::default(),
                42,
                7
            ));
        }

        #[test]
        fn selected_context_guard_expires_idle_and_collected_windows() {
            let guard = state();
            assert!(!guard.valid_at(guard.watching_since + WATCH_LIFETIME));
            let end = Instant::now() + READ_WINDOW;
            *guard.deadline.lock().unwrap() = Some(end);
            assert!(guard.valid_at(end - Duration::from_millis(1)));
            assert!(!guard.valid_at(end));
        }

        #[test]
        fn selected_context_guard_bounds_unicode_and_skips_empty_selection() {
            let text = "🙂".repeat(MAX_SELECTED_CHARS + 10);
            assert!(bounded_selection(&text).is_none());
            assert_eq!(
                bounded_selection("  original  ").as_deref(),
                Some("  original  ")
            );
            assert!(bounded_selection(" \n\t ").is_none());
        }

        #[test]
        fn same_field_selection_a_to_b_is_refused_before_and_after_read() {
            use std::cell::Cell;
            for changed_during_read in [false, true] {
                let guard = prepared();
                let range = Cell::new(if changed_during_read { (2, 4) } else { (8, 4) });
                let reads = Cell::new(0);
                let result = guard.read_with_backend(
                    |_, _| matches_original_range(Some((2, 4)), Some(range.get())).then_some(()),
                    |_, _| {
                        reads.set(reads.get() + 1);
                        range.set((8, 4));
                        Some("A".into())
                    },
                    |_| true,
                );
                assert_eq!(result, None);
                assert_eq!(reads.get(), usize::from(changed_during_read));
            }
            assert!(!matches_original_range(None, None));
            assert!(matches_original_range(Some((2, 4)), Some((2, 4))));
        }

        #[test]
        fn same_range_content_notification_invalidates_even_after_restore() {
            let guard = prepared();
            assert!(matches_original_range(Some((2, 4)), Some((2, 4))));
            guard.invalidate();
            assert!(!guard.is_valid());
            assert_eq!(
                guard.read_with_backend(
                    |_, _| Some(()),
                    |_, _| panic!("restored content cannot clear mutation"),
                    |_| true
                ),
                None
            );
        }

        #[test]
        fn session_selection_owner_survives_read_window_and_rejects_late_mutation() {
            let mut raw = state();
            raw.lifetime = Duration::from_secs(900);
            raw.explicit_snapshot.store(true, Ordering::Release);
            let (flush, _) = mpsc::channel();
            let guard = PreparedDictationSelectedContext {
                expected: DeliveryFieldFingerprint {
                    pid: Some(42),
                    element_hash: Some(7),
                    ..Default::default()
                },
                state: Arc::new(raw),
                flush,
            };
            assert_eq!(
                guard
                    .read_with_backend(|_, _| Some(()), |_, _| Some("original".into()), |_| true)
                    .as_deref(),
                Some("original")
            );
            assert!(guard
                .state
                .valid_at(guard.state.watching_since + Duration::from_secs(60)));
            guard.invalidate();
            assert!(!guard.is_valid());
        }

        #[test]
        fn session_selection_native_paste_refuses_mutation_after_read_or_staging() {
            use std::cell::Cell;
            for mutation in [
                "after_asr",
                "after_model",
                "after_archive",
                "after_staging",
                "unchanged",
            ] {
                let guard = prepared();
                assert_eq!(
                    guard
                        .read_with_backend(|_, _| Some(()), |_, _| Some("A".into()), |_| true)
                        .as_deref(),
                    Some("A")
                );
                let snapshots = Cell::new(0);
                let stages = Cell::new(0);
                let dispatches = Cell::new(0);
                let restores = Cell::new(0);
                if matches!(mutation, "after_asr" | "after_model" | "after_archive") {
                    guard.invalidate();
                }
                let result = super::super::stage_and_dispatch_native_paste(
                    "output",
                    || {
                        if guard.is_valid() {
                            Ok(())
                        } else {
                            Err(PasteDispatchFailure::Refused("Selection changed".into()))
                        }
                    },
                    || {
                        snapshots.set(snapshots.get() + 1);
                        Ok("original clipboard")
                    },
                    |_, _| {
                        stages.set(stages.get() + 1);
                        if mutation == "after_staging" {
                            guard.invalidate();
                        }
                        Ok(9)
                    },
                    || 9,
                    |_| {
                        dispatches.set(dispatches.get() + 1);
                        Ok(PasteDispatchStatus::Confirmed)
                    },
                    |_, _| {
                        restores.set(restores.get() + 1);
                        Ok(true)
                    },
                );
                assert_eq!(result.is_ok(), mutation == "unchanged");
                assert_eq!(dispatches.get(), usize::from(mutation == "unchanged"));
                assert_eq!(restores.get(), usize::from(mutation == "after_staging"));
                assert_eq!(
                    snapshots.get(),
                    usize::from(matches!(mutation, "after_staging" | "unchanged"))
                );
                assert_eq!(stages.get(), snapshots.get());
            }
        }

        #[test]
        fn session_selection_mutation_during_system_events_blocks_fallback() {
            use std::cell::Cell;
            let guard = prepared();
            let fallback = Cell::new(0);
            let result = super::super::send_native_paste_with_fallback(
                || {
                    if guard.is_valid() {
                        Ok(())
                    } else {
                        Err(PasteDispatchFailure::Refused("Selection changed".into()))
                    }
                },
                || {
                    guard.invalidate();
                    Err("System Events failed".into())
                },
                || {
                    fallback.set(fallback.get() + 1);
                    Ok(())
                },
            );
            assert!(matches!(result, Err(PasteDispatchFailure::Refused(_))));
            assert_eq!(fallback.get(), 0);
        }

        #[test]
        fn session_selection_debug_does_not_include_snapshot() {
            let guard = prepared();
            guard.use_explicit_snapshot();
            assert_eq!(
                guard
                    .read_with_backend(
                        |_, _| Some(()),
                        |_, _| Some("private selected words".into()),
                        |_| true
                    )
                    .as_deref(),
                Some("private selected words")
            );
            assert_eq!(format!("{guard:?}"), "PreparedDictationSelectedContext");
        }

        #[test]
        fn session_selection_drop_stops_observer_state() {
            let guard = prepared();
            let state = Arc::clone(&guard.state);
            drop(guard);
            assert!(state.stopped.load(Ordering::Acquire));
            assert!(!state.valid_at(Instant::now()));
        }

        #[test]
        fn selected_context_guard_is_send_and_sync_without_native_objects() {
            fn assert_send_sync<T: Send + Sync>() {}
            assert_send_sync::<PreparedDictationSelectedContext>();
        }
    }
}

#[cfg(target_os = "macos")]
fn current_delivery_field_fingerprint(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Option<DeliveryFieldFingerprint> {
    let element = copy_frontmost_focused_accessibility_element(target_app, target_app_bundle_id)
        .ok()
        .flatten()?;
    let fingerprint = if classify_focused_element_security(element).is_none() {
        delivery_fingerprint_from_element(element)
    } else {
        None
    };
    unsafe { CFRelease(element) };
    fingerprint
}

#[cfg(target_os = "macos")]
fn guard_delivery_field(
    expected: Option<&DeliveryFieldFingerprint>,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    validate_delivery_field_identity(
        expected,
        current_delivery_field_fingerprint(target_app, target_app_bundle_id).as_ref(),
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn guard_current_delivery_field(
    expected: Option<&DeliveryFieldFingerprint>,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    guard_delivery_field(expected, target_app, target_app_bundle_id)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn guard_current_delivery_field(
    _expected: Option<&DeliveryFieldFingerprint>,
    _target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    Ok(())
}

/// The focused field's identity now, `None` for a secure field or when it
/// cannot be read. Other platforms cannot read it at all.
pub(crate) fn current_focused_field_fingerprint(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Option<DeliveryFieldFingerprint> {
    #[cfg(target_os = "macos")]
    {
        current_delivery_field_fingerprint(target_app, target_app_bundle_id)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (target_app, target_app_bundle_id);
        None
    }
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
/// the current field's metadata and, for correction readback, verifies its
/// fingerprint before reading text. Bringing an app
/// forward in order to read it would be both a focus theft and a way of
/// manufacturing the agreement the identity check is supposed to test for.
pub(crate) struct MacosFocusedFieldReader {
    #[cfg(any(target_os = "macos", test))]
    original: DeliveryFieldFingerprint,
}

impl MacosFocusedFieldReader {
    pub(crate) fn from_original(original: Option<&DeliveryFieldFingerprint>) -> Option<Self> {
        let original = original?;
        original.pid?;
        original.element_hash?;
        Some(Self {
            #[cfg(any(target_os = "macos", test))]
            original: original.clone(),
        })
    }

    #[cfg(any(target_os = "macos", test))]
    fn read_original_value<T>(
        &self,
        current: &dictation_correction_capture::FocusedFieldFingerprint,
        read: impl FnOnce() -> Option<T>,
    ) -> Option<T> {
        let matches = self.original.pid == current.pid
            && self.original.element_hash == current.native_element_hash
            && self.original.role == current.role
            && self.original.identifier == current.identifier
            && self.original.app_bundle_id == current.frontmost_bundle_id
            && self.original.app_name == current.frontmost_app_name;
        matches.then(read).flatten()
    }
}

impl dictation_correction_capture::FocusedFieldReader for MacosFocusedFieldReader {
    fn read_focused_field(
        &self,
    ) -> Result<Option<dictation_correction_capture::FocusedFieldSnapshot>, String> {
        #[cfg(target_os = "macos")]
        {
            Ok(correction_observer::read_initial_field(self))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(None)
        }
    }

    fn read_focused_field_matching(
        &self,
        insertion: &dictation_correction_capture::FocusedFieldFingerprint,
    ) -> Result<Option<dictation_correction_capture::FocusedFieldSnapshot>, String> {
        #[cfg(target_os = "macos")]
        {
            Ok(self.read_original_value(insertion, || {
                correction_observer::read_current_field(insertion)
            }))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = insertion;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod correction_anchor_identity_tests {
    use super::*;
    use dictation_correction_capture::{FocusedFieldFingerprint, FocusedFieldFrame};

    fn original() -> DeliveryFieldFingerprint {
        DeliveryFieldFingerprint {
            pid: Some(42),
            element_hash: Some(7),
            role: Some("AXTextArea".into()),
            identifier: Some("composer".into()),
            frame: Some(FocusedFieldFrame::default()),
            app_bundle_id: Some("example.editor".into()),
            app_name: Some("Editor".into()),
        }
    }

    fn current() -> FocusedFieldFingerprint {
        let original = original();
        FocusedFieldFingerprint {
            pid: original.pid,
            native_element_hash: original.element_hash,
            role: original.role,
            identifier: original.identifier,
            frame: original.frame,
            frontmost_bundle_id: original.app_bundle_id,
            frontmost_app_name: original.app_name,
            ..Default::default()
        }
    }

    fn assert_no_value_read(current: &FocusedFieldFingerprint) {
        let reader = MacosFocusedFieldReader::from_original(Some(&original())).unwrap();
        assert_eq!(
            reader.read_original_value(current, || { panic!("unrelated fields must not be read") }),
            None::<()>
        );
    }

    #[test]
    fn wrong_application_never_reads_value() {
        let mut field = current();
        field.pid = Some(43);
        assert_no_value_read(&field);
        field = current();
        field.frontmost_bundle_id = Some("another.editor".into());
        assert_no_value_read(&field);
    }

    #[test]
    fn sibling_field_never_reads_value() {
        let mut field = current();
        field.native_element_hash = Some(8);
        assert_no_value_read(&field);
        field = current();
        field.identifier = Some("search".into());
        assert_no_value_read(&field);
    }

    #[test]
    fn missing_native_identity_cannot_create_reader_or_read_value() {
        assert!(MacosFocusedFieldReader::from_original(None).is_none());
        let mut expected = original();
        expected.pid = None;
        assert!(MacosFocusedFieldReader::from_original(Some(&expected)).is_none());
        expected = original();
        expected.element_hash = None;
        assert!(MacosFocusedFieldReader::from_original(Some(&expected)).is_none());
        let mut field = current();
        field.native_element_hash = None;
        assert_no_value_read(&field);
    }

    #[test]
    fn original_native_field_can_resize_before_anchor_read() {
        let reader = MacosFocusedFieldReader::from_original(Some(&original())).unwrap();
        let mut field = current();
        field.frame = Some(FocusedFieldFrame {
            width: 900,
            height: 500,
            ..Default::default()
        });
        assert_eq!(
            reader.read_original_value(&field, || Some("inserted text")),
            Some("inserted text")
        );
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
) -> Result<bool, AccessibilityInsertFailure> {
    let Some(focused_element) = copy_focused_accessibility_element(
        target_app,
        target_app_bundle_id,
        "Accessibility could not create the system-wide element.".to_string(),
    )
    .map_err(AccessibilityInsertFailure::TargetChanged)?
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
    if let Err(error) = ensure_focused_element_still_matches_target(
        focused_element,
        target_app,
        target_app_bundle_id,
    ) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::TargetChanged(error));
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

    if let Err(error) = ensure_focused_element_still_matches_target(
        focused_element,
        target_app,
        target_app_bundle_id,
    ) {
        unsafe { CFRelease(focused_element) };
        return Err(AccessibilityInsertFailure::TargetChanged(error));
    }
    if let Err(error) = ax_set_string_attribute(focused_element, "AXValue", text) {
        unsafe { CFRelease(focused_element) };
        return Err(error.into());
    }
    // A successful AX setter can still be ignored by the target application.
    // Once accepted, only read back; never retry an uncertain replacement.
    let confirmed = confirm_accessibility_text_change(
        text,
        || {
            ensure_focused_element_still_matches_target(
                focused_element,
                target_app,
                target_app_bundle_id,
            )
            .is_ok()
        },
        || {
            ax_copy_string_attribute(focused_element, "AXValue")
                .ok()
                .flatten()
        },
        || std::thread::sleep(std::time::Duration::from_millis(40)),
    );
    if confirmed
        && ax_is_attribute_settable(focused_element, "AXSelectedTextRange").unwrap_or(false)
    {
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
    Ok(confirmed)
}

#[cfg(any(test, target_os = "macos"))]
fn confirm_accessibility_text_change(
    expected: &str,
    mut is_current_field: impl FnMut() -> bool,
    mut read_value: impl FnMut() -> Option<String>,
    mut wait: impl FnMut(),
) -> bool {
    for _ in 0..6 {
        if !is_current_field() {
            return false;
        }
        if read_value().as_deref() == Some(expected) && is_current_field() {
            return true;
        }
        wait();
    }
    false
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
            Ok(confirmed) => {
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
                    confirmed,
                    paste_requested: false,
                    successful_strategy: Some(CursorInsertStrategy::AccessibilityDirectText),
                    secure_field: None,
                    error: (!confirmed).then(|| "Replacement was sent, but the field change could not be verified. Check the target before replacing again.".to_string()),
                }
            }
            Err(AccessibilityInsertFailure::SecureField(signal)) => {
                secure_field_refusal_outcome(signal)
            }
            Err(AccessibilityInsertFailure::TargetChanged(error)) => {
                delivery_refusal_outcome(error)
            }
            Err(AccessibilityInsertFailure::Other(error)) => {
                let copied = copy_to_clipboard(text).is_ok();
                PasteOutcome {
                    pasted: false,
                    copied,
                    direct_accessibility: false,
                    confirmed: false,
                    paste_requested: false,
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
            paste_requested: false,
            successful_strategy: None,
            secure_field: None,
            error: Some("Focused-field replacement is only implemented on macOS.".to_string()),
        }
    }
}

/// Whether delivery should bring the dictation target back to the front before
/// checking that its field still has focus.
///
/// Only when Plainsong itself or a transient system surface took the front
/// while the session was processing. On macOS a click on the dictation pill's
/// Stop button, the menu bar item or the main window activates Plainsong, and
/// the field-identity check that guards delivery then found Plainsong in front,
/// refused to paste, and left the words only inside the popup. The user never
/// chose a different destination in that case; they pressed Stop.
///
/// Another app in front is different: the user switched there on purpose, and
/// pulling them back would be a focus theft. That case keeps the refusal (and
/// the clipboard fallback the stop path adds after it).
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn should_restore_target_before_delivery(
    frontmost_app: Option<&str>,
    frontmost_bundle_id: Option<&str>,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> bool {
    let target_known = [target_app, target_app_bundle_id]
        .into_iter()
        .flatten()
        .any(|value| !value.trim().is_empty());
    if !target_known || is_self_activation_target(target_app, target_app_bundle_id) {
        return false;
    }
    let frontmost_known = [frontmost_app, frontmost_bundle_id]
        .into_iter()
        .flatten()
        .any(|value| !value.trim().is_empty());
    frontmost_known
        && (is_self_activation_target(frontmost_app, frontmost_bundle_id)
            || is_transient_activation_target(frontmost_app, frontmost_bundle_id))
}

/// Bring the dictation target back when Plainsong took the front during the
/// session (see `should_restore_target_before_delivery`). Best effort: a target
/// that does not come back leaves the field check to refuse, and the stop path
/// then puts the words on the clipboard.
#[cfg(target_os = "macos")]
pub(crate) fn restore_target_after_self_focus(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) {
    let Some(frontmost) = frontmost_application_identity() else {
        return;
    };
    if !should_restore_target_before_delivery(
        frontmost.name.as_deref(),
        frontmost.bundle_id.as_deref(),
        target_app,
        target_app_bundle_id,
    ) {
        return;
    }
    tracing::info!(
        "Plainsong was in front when dictation finished; bringing the dictation target back before delivery"
    );
    if let Err(error) = reactivate_target_application(target_app, target_app_bundle_id) {
        tracing::warn!("Could not bring the dictation target back: {}", error);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn restore_target_after_self_focus(
    _target_app: Option<&str>,
    _target_app_bundle_id: Option<&str>,
) {
}

/// The general pasteboard's change count, where the platform has one. Lets the
/// stop path tell "delivery never touched the clipboard" from "delivery staged
/// and restored it" or "the user copied something meanwhile".
pub(crate) fn clipboard_change_count() -> Option<isize> {
    #[cfg(target_os = "macos")]
    {
        Some(macos_clipboard_change_count())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Whether nobody but Plainsong changed the clipboard since `before`.
///
/// True when the count has not moved, or when the last change was Plainsong
/// putting back the very clipboard that was there at `before` (a refused paste
/// restores what it staged). False when anything else wrote to it: that is the
/// user copying something during delivery, and their copy must survive.
///
/// The restore has to be traced to `before`, not merely be the latest write.
/// With A on the clipboard at `before`, a user copy B, then a staged paste that
/// was refused and put B back, the count matches Plainsong's restore while the
/// clipboard holds B, the user's newer copy. That restore came from a snapshot
/// taken at B's count, so it does not count as untouched.
pub(crate) fn clipboard_unchanged_by_others_since(before: Option<isize>) -> bool {
    #[cfg(target_os = "macos")]
    let last_restore = last_clipboard_restore();
    #[cfg(not(target_os = "macos"))]
    let last_restore = None;
    clipboard_unchanged_by_others(before, clipboard_change_count(), last_restore)
}

/// Plainsong's last clipboard restore: the change count of the clipboard it
/// snapshotted, and the change count right after it wrote that snapshot back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClipboardRestoreMark {
    pub(crate) restored_from: isize,
    pub(crate) restored_at: isize,
}

pub(crate) fn clipboard_unchanged_by_others(
    before: Option<isize>,
    now: Option<isize>,
    last_plainsong_restore: Option<ClipboardRestoreMark>,
) -> bool {
    if now == before {
        return true;
    }
    match (before, now, last_plainsong_restore) {
        (Some(before), Some(now), Some(mark)) => {
            mark.restored_at == now && mark.restored_from == before
        }
        _ => false,
    }
}

/// What `reactivate_target_application` had to do to put the target in front.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TargetActivation {
    /// The target was already frontmost, or there was no target to bring back.
    Unchanged,
    /// The target was brought forward with `open`.
    Activated,
}

#[cfg(target_os = "macos")]
impl TargetActivation {
    /// Gives a just-activated app's window time to hand focus to its field.
    /// An app that stayed in front already has it, so nothing waits.
    pub(crate) fn settle(self, delay: std::time::Duration) {
        if self == Self::Activated {
            std::thread::sleep(delay);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn reactivate_target_application(
    app_name: Option<&str>,
    app_bundle_id: Option<&str>,
) -> Result<TargetActivation, String> {
    if is_self_activation_target(app_name, app_bundle_id) {
        return Ok(TargetActivation::Unchanged);
    }

    let trimmed_name = app_name.map(str::trim).filter(|value| !value.is_empty());
    let trimmed_bundle_id = app_bundle_id
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if trimmed_name.is_none() && trimmed_bundle_id.is_none() {
        return Ok(TargetActivation::Unchanged);
    }

    if frontmost_application_identity()
        .as_ref()
        .is_some_and(|focused| {
            focused_application_matches_target(focused, trimmed_name, trimmed_bundle_id)
        })
    {
        tracing::info!(
            "Target app '{}' is already frontmost; skipping app reactivation to preserve field focus",
            trimmed_name.or(trimmed_bundle_id).unwrap_or("unknown")
        );
        return Ok(TargetActivation::Unchanged);
    }

    // `open -b` / `open -a` launch an application that is not running. A
    // target the user quit while the words were transcribing must not be
    // started again just to receive them: refuse instead, and the stop path
    // puts the words on the clipboard. An answer we cannot read counts as
    // not running for the same reason.
    if !target_application_is_running(trimmed_name, trimmed_bundle_id) {
        return Err(format!(
            "'{}' is no longer open, so Plainsong did not reopen it. No paste was sent.",
            trimmed_name
                .or(trimmed_bundle_id)
                .unwrap_or("The target app")
        ));
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

    if wait_for_target_activation(
        || {
            frontmost_application_identity()
                .as_ref()
                .is_some_and(|focused| {
                    focused_application_matches_target(focused, trimmed_name, trimmed_bundle_id)
                })
        },
        std::thread::sleep,
    ) {
        return Ok(TargetActivation::Activated);
    }

    Err(format!(
        "Activation for target app '{}' did not confirm. No paste was sent.",
        trimmed_name.or(trimmed_bundle_id).unwrap_or("unknown")
    ))
}

#[cfg(any(test, target_os = "macos"))]
fn wait_for_target_activation(
    mut is_target: impl FnMut() -> bool,
    mut wait: impl FnMut(std::time::Duration),
) -> bool {
    for attempt in 0..=18 {
        if is_target() {
            // The app is active; retain the existing field-focus settle time.
            wait(std::time::Duration::from_millis(80));
            return true;
        }
        if attempt < 18 {
            wait(std::time::Duration::from_millis(40));
        }
    }
    false
}

#[cfg(test)]
mod activation_wait_tests {
    use super::wait_for_target_activation;
    use std::time::Duration;

    #[test]
    fn already_activated_target_only_waits_for_field_focus() {
        let mut waits = Vec::new();
        assert!(wait_for_target_activation(
            || true,
            |delay| waits.push(delay)
        ));
        assert_eq!(waits, [Duration::from_millis(80)]);
    }

    #[test]
    fn slow_activation_keeps_its_deadline_and_field_settle() {
        let mut checks = 0;
        let mut waits = Vec::new();
        assert!(wait_for_target_activation(
            || {
                checks += 1;
                checks == 3
            },
            |delay| waits.push(delay),
        ));
        assert_eq!(
            waits,
            [
                Duration::from_millis(40),
                Duration::from_millis(40),
                Duration::from_millis(80)
            ]
        );
        waits.clear();
        assert!(!wait_for_target_activation(
            || false,
            |delay| waits.push(delay)
        ));
        assert_eq!(waits, vec![Duration::from_millis(40); 18]);
    }
}

/// Whether `lsappinfo find` named at least one running application.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn lsappinfo_find_reports_running(output: &str) -> bool {
    output
        .lines()
        .any(|line| line.trim_start().starts_with("ASN:"))
}

/// Ask LaunchServices whether the dictation target is running, without
/// launching anything. Bundle id first, the display name when that is all the
/// session captured. `false` when the question could not be answered.
#[cfg(target_os = "macos")]
fn target_application_is_running(name: Option<&str>, bundle_id: Option<&str>) -> bool {
    let query = match (bundle_id, name) {
        (Some(bundle_id), _) => format!("bundleid={bundle_id}"),
        (None, Some(name)) => format!("name={name}"),
        (None, None) => return false,
    };
    match std::process::Command::new("/usr/bin/lsappinfo")
        .args(["find", &query])
        .output()
    {
        Ok(output) if output.status.success() => {
            lsappinfo_find_reports_running(&String::from_utf8_lossy(&output.stdout))
        }
        Ok(output) => {
            tracing::warn!(
                "lsappinfo could not check whether the dictation target is running (status {})",
                output.status
            );
            false
        }
        Err(error) => {
            tracing::warn!(
                "lsappinfo could not check whether the dictation target is running: {}",
                error
            );
            false
        }
    }
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
const ANSI_V_KEYCODE: u16 = 9;
#[cfg(target_os = "macos")]
const ANSI_C_KEYCODE: u16 = 8;

/// The key that types `character` while Command is held. Apps match shortcuts
/// by that character, so a fixed ANSI position sends Cmd+. for Cmd+V on Dvorak.
#[cfg(any(test, target_os = "macos"))]
fn command_shortcut_keycode(
    character: char,
    ansi_keycode: u16,
    translate: impl Fn(u16) -> Option<char>,
) -> Option<u16> {
    std::iter::once(ansi_keycode)
        .chain(0..128)
        .find(|&keycode| translate(keycode) == Some(character))
}

#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
    fn LMGetKbdType() -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn UCKeyTranslate(
        layout: *const std::ffi::c_void,
        key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_length: usize,
        actual_length: *mut usize,
        unicode: *mut u16,
    ) -> i32;
}

/// Text Input Source calls belong on the main thread.
#[cfg(target_os = "macos")]
fn layout_command_keycode(character: char, ansi_keycode: u16) -> Option<u16> {
    use core_foundation::base::CFType;
    use core_foundation_sys::data::{CFDataGetBytePtr, CFDataRef};

    const KEY_ACTION_DOWN: u16 = 0;
    const COMMAND_KEY_STATE: u32 = 0x0100 >> 8;
    const NO_DEAD_KEYS: u32 = 1;

    let copy_sources: [unsafe extern "C" fn() -> CFTypeRef; 2] = [
        TISCopyCurrentKeyboardLayoutInputSource,
        TISCopyCurrentASCIICapableKeyboardLayoutInputSource,
    ];
    copy_sources.into_iter().find_map(|copy_source| {
        let source = unsafe { copy_source() };
        if source.is_null() {
            return None;
        }
        let source = unsafe { CFType::wrap_under_create_rule(source) };
        let data = unsafe {
            TISGetInputSourceProperty(source.as_CFTypeRef(), kTISPropertyUnicodeKeyLayoutData)
        } as CFDataRef;
        if data.is_null() {
            return None;
        }
        let layout = unsafe { CFDataGetBytePtr(data) }.cast::<std::ffi::c_void>();
        let keyboard_type = u32::from(unsafe { LMGetKbdType() });
        command_shortcut_keycode(character, ansi_keycode, |keycode| {
            let mut dead_key_state = 0;
            let mut length = 0;
            let mut unicode = [0u16; 4];
            let status = unsafe {
                UCKeyTranslate(
                    layout,
                    keycode,
                    KEY_ACTION_DOWN,
                    COMMAND_KEY_STATE,
                    keyboard_type,
                    NO_DEAD_KEYS,
                    &mut dead_key_state,
                    unicode.len(),
                    &mut length,
                    unicode.as_mut_ptr(),
                )
            };
            (status == 0 && length == 1)
                .then(|| char::from_u32(u32::from(unicode[0])))
                .flatten()
        })
    })
}

#[cfg(target_os = "macos")]
fn current_layout_command_keycode(character: char, ansi_keycode: u16) -> u16 {
    run_on_main_run_loop(
        move || layout_command_keycode(character, ansi_keycode),
        std::time::Duration::from_millis(100),
    )
    .flatten()
    .unwrap_or(ansi_keycode)
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

/// One plain Return to the focused element, for "Press Return after
/// inserting". Single attempt by design: both events are built before either
/// is posted, so a failure never leaves half a key press or invites a second
/// Return. kVK_Return (36) is the same on every keyboard layout.
#[cfg(target_os = "macos")]
pub(crate) fn send_return_key() -> Result<(), String> {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const RETURN_KEYCODE: CGKeyCode = 36;
    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "Failed to create event source".to_string())?;
    let key_down = CGEvent::new_keyboard_event(source.clone(), RETURN_KEYCODE, true)
        .map_err(|_| "Failed to create Return key down event".to_string())?;
    let key_up = CGEvent::new_keyboard_event(source, RETURN_KEYCODE, false)
        .map_err(|_| "Failed to create Return key up event".to_string())?;
    // A modifier still held from the shortcut would turn this into
    // Shift+Return (a new line in most chat boxes) or Cmd+Return.
    key_down.set_flags(CGEventFlags::CGEventFlagNull);
    key_up.set_flags(CGEventFlags::CGEventFlagNull);
    key_down.post(CGEventTapLocation::Session);
    std::thread::sleep(std::time::Duration::from_millis(8));
    key_up.post(CGEventTapLocation::Session);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn send_return_key() -> Result<(), String> {
    Err("Pressing Return after inserting is only available on macOS.".to_string())
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PasteDispatchStatus {
    Confirmed,
    FallbackDispatched,
}

#[cfg(target_os = "macos")]
fn send_native_paste_key(
    expected: &FocusedApplicationIdentity,
    owned_change_count: isize,
    expected_field: Option<&DeliveryFieldFingerprint>,
    selection: Option<&PreparedDictationSelectedContext>,
) -> Result<PasteDispatchStatus, PasteDispatchFailure> {
    let paste_keycode = current_layout_command_keycode('v', ANSI_V_KEYCODE);
    send_native_paste_with_fallback(
        || {
            guard_delivery_field(
                expected_field,
                expected.name.as_deref(),
                expected.bundle_id.as_deref(),
            )
            .map_err(PasteDispatchFailure::Refused)?;
            if selection.is_some_and(|guard| !guard.verify_original_selection()) {
                return Err(PasteDispatchFailure::Refused(
                    DICTATION_FOCUS_CHANGED_MESSAGE.into(),
                ));
            }

            verify_staged_native_paste(
                expected,
                frontmost_application_identity,
                probe_focused_secure_field,
                macos_clipboard_change_count,
                owned_change_count,
            )
        },
        || match std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(format!(
                "tell application \"System Events\" to key code {} using command down",
                paste_keycode
            ))
            .output()
        {
            Ok(output) if output.status.success() => {
                tracing::info!("Cmd+V posted via System Events");
                Ok(())
            }
            Ok(output) => Err(format!(
                "System Events exited with {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => Err(format!("Failed to invoke osascript for paste: {}", error)),
        },
        || dispatch_command_keystroke(paste_keycode),
    )
}

#[cfg(any(test, target_os = "macos"))]
fn send_native_paste_with_fallback(
    mut verify: impl FnMut() -> Result<(), PasteDispatchFailure>,
    system_events: impl FnOnce() -> Result<(), String>,
    core_graphics: impl FnOnce() -> Result<(), String>,
) -> Result<PasteDispatchStatus, PasteDispatchFailure> {
    verify()?;
    let system_events_error = match system_events() {
        Ok(()) => return Ok(PasteDispatchStatus::Confirmed),
        Err(error) => error,
    };
    // System Events may have blocked while the user changed focus or copied
    // something. Neither the target nor clipboard ownership carries forward.
    verify()?;
    core_graphics()
        .map(|()| PasteDispatchStatus::FallbackDispatched)
        .map_err(|error| {
            PasteDispatchFailure::Other(format!(
                "{}; CoreGraphics paste failed: {}",
                system_events_error, error
            ))
        })
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Eq, PartialEq)]
struct ClipboardEntry {
    type_name: String,
    data: Vec<u8>,
}

#[cfg(any(test, target_os = "macos"))]
#[derive(Clone, Eq, PartialEq)]
struct ClipboardSnapshot {
    source_change_count: isize,
    items: Vec<Vec<ClipboardEntry>>,
}

#[cfg(any(test, target_os = "macos"))]
fn push_bounded_clipboard_entry(
    entries: &mut Vec<ClipboardEntry>,
    total_bytes: &mut usize,
    type_name: String,
    data: Vec<u8>,
    maximum_bytes: usize,
) -> Result<(), String> {
    *total_bytes = total_bytes
        .checked_add(type_name.len())
        .and_then(|total| total.checked_add(data.len()))
        .ok_or_else(|| "The clipboard snapshot size overflowed.".to_string())?;
    if *total_bytes > maximum_bytes {
        return Err(format!(
            "The clipboard exceeds the {} MiB preservation limit.",
            maximum_bytes / (1024 * 1024)
        ));
    }
    entries.push(ClipboardEntry { type_name, data });
    Ok(())
}

#[cfg(target_os = "macos")]
const MAX_CLIPBOARD_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_CLIPBOARD_SNAPSHOT_ITEMS: usize = 1024;
#[cfg(target_os = "macos")]
const MAX_CLIPBOARD_SNAPSHOT_TYPES: usize = 4096;

#[cfg(target_os = "macos")]
fn snapshot_macos_clipboard() -> Result<ClipboardSnapshot, String> {
    use objc2_app_kit::NSPasteboard;

    let pasteboard = NSPasteboard::generalPasteboard();
    let initial_change_count = pasteboard.changeCount();
    let pasteboard_items = pasteboard.pasteboardItems();
    let item_count = pasteboard_items.as_ref().map_or(0, |items| items.count());
    if item_count > MAX_CLIPBOARD_SNAPSHOT_ITEMS {
        return Err("The clipboard has too many items to preserve safely.".to_string());
    }
    let mut snapshot = ClipboardSnapshot {
        source_change_count: initial_change_count,
        items: Vec::with_capacity(item_count),
    };
    let mut total_bytes = 0usize;
    let mut total_types = 0usize;

    if let Some(items) = pasteboard_items {
        for item_index in 0..items.count() {
            let item = items.objectAtIndex(item_index);
            let types = item.types();
            total_types = total_types
                .checked_add(types.count())
                .ok_or_else(|| "The clipboard type count overflowed.".to_string())?;
            if total_types > MAX_CLIPBOARD_SNAPSHOT_TYPES {
                return Err(
                    "The clipboard has too many declared types to preserve safely.".to_string(),
                );
            }
            let mut entries = Vec::with_capacity(types.count());
            for type_index in 0..types.count() {
                let data_type = types.objectAtIndex(type_index);
                let type_name = data_type.to_string();
                let data = item.dataForType(&data_type).ok_or_else(|| {
                    "A clipboard item could not provide data for every declared type.".to_string()
                })?;
                let prospective_bytes = total_bytes
                    .checked_add(type_name.len())
                    .and_then(|total| total.checked_add(data.length()))
                    .ok_or_else(|| "The clipboard snapshot size overflowed.".to_string())?;
                if prospective_bytes > MAX_CLIPBOARD_SNAPSHOT_BYTES {
                    return Err("The clipboard exceeds the 64 MiB preservation limit.".to_string());
                }
                let bytes = data.to_vec();
                push_bounded_clipboard_entry(
                    &mut entries,
                    &mut total_bytes,
                    type_name,
                    bytes,
                    MAX_CLIPBOARD_SNAPSHOT_BYTES,
                )?;
            }
            snapshot.items.push(entries);
        }
    } else if pasteboard.types().is_some_and(|types| types.count() != 0) {
        return Err("The clipboard advertised data but exposed no preservable items.".to_string());
    }

    if pasteboard.changeCount() != initial_change_count {
        return Err("The clipboard changed while Plainsong was preserving it.".to_string());
    }
    Ok(snapshot)
}

/// Marker types (nspasteboard.org convention) that ask clipboard managers not
/// to record or display an item. Only Plainsong's own staged dictation carries
/// them; a restored user clipboard is written back exactly as captured.
#[cfg(target_os = "macos")]
fn staged_dictation_marker_types() -> [&'static str; 2] {
    [
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.TransientType",
    ]
}

/// Set while the sidecar's main thread services its run loop. AppKit asks a
/// promised-pasteboard provider for data only on the main run loop; with the
/// main thread blocked, a pasting app waits two minutes and receives nothing.
#[cfg(target_os = "macos")]
static MAIN_RUN_LOOP_SERVICED: AtomicBool = AtomicBool::new(false);

/// Runs `work` on a worker thread while the main thread services its run loop,
/// so staged dictation can use promised pasteboard data.
#[cfg(target_os = "macos")]
pub fn run_with_main_run_loop<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> std::io::Result<T> {
    use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopTimer};
    use core_foundation_sys::runloop::CFRunLoopTimerRef;

    extern "C" fn keep_alive(_: CFRunLoopTimerRef, _: *mut std::ffi::c_void) {}

    let (sender, receiver) = std::sync::mpsc::channel();
    // Set before the worker starts; a ping that arrives before the loop
    // below begins is answered once it does.
    let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
    MAIN_RUN_LOOP_SERVICED.store(true, Ordering::SeqCst);
    let worker = std::thread::Builder::new()
        .name("sidecar-runtime".to_string())
        // The work previously ran on the main thread, which has an 8 MiB stack.
        .stack_size(8 * 1024 * 1024)
        .spawn(move || {
            let _ = sender.send(work());
            CFRunLoop::get_main().stop();
        })
        .inspect_err(|_| MAIN_RUN_LOOP_SERVICED.store(false, Ordering::SeqCst))?;
    // A run loop without sources returns immediately; this timer never fires.
    let timer = CFRunLoopTimer::new(
        unsafe { core_foundation_sys::date::CFAbsoluteTimeGetCurrent() } + 1e9,
        0.0,
        0,
        0,
        keep_alive,
        std::ptr::null_mut(),
    );
    CFRunLoop::get_current().add_timer(&timer, unsafe { kCFRunLoopDefaultMode });
    let result = loop {
        match receiver.try_recv() {
            Ok(result) => break result,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                MAIN_RUN_LOOP_SERVICED.store(false, Ordering::SeqCst);
                if let Err(payload) = worker.join() {
                    std::panic::resume_unwind(payload);
                }
                return Err(std::io::Error::other("The sidecar worker stopped early."));
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {
                CFRunLoop::run_in_mode(
                    unsafe { kCFRunLoopDefaultMode },
                    std::time::Duration::from_secs(1),
                    false,
                );
            }
        }
    };
    MAIN_RUN_LOOP_SERVICED.store(false, Ordering::SeqCst);
    let _ = worker.join();
    Ok(result)
}

#[cfg(not(target_os = "macos"))]
pub fn run_with_main_run_loop<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> std::io::Result<T> {
    Ok(work())
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRunLoopPerformBlock(
        run_loop: core_foundation_sys::runloop::CFRunLoopRef,
        mode: CFTypeRef,
        block: &block2::Block<dyn Fn()>,
    );
}

/// Runs `work` on the main run loop, waiting at most `timeout` for it.
#[cfg(target_os = "macos")]
fn run_on_main_run_loop<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    timeout: std::time::Duration,
) -> Option<T> {
    use core_foundation_sys::runloop::{kCFRunLoopDefaultMode, CFRunLoopGetMain, CFRunLoopWakeUp};

    if !MAIN_RUN_LOOP_SERVICED.load(Ordering::SeqCst) {
        return None;
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let work = std::sync::Mutex::new(Some(work));
    let block = block2::RcBlock::new(move || {
        if let Some(work) = work.lock().ok().and_then(|mut work| work.take()) {
            let _ = sender.try_send(work());
        }
    });
    unsafe {
        CFRunLoopPerformBlock(CFRunLoopGetMain(), kCFRunLoopDefaultMode.cast(), &block);
        CFRunLoopWakeUp(CFRunLoopGetMain());
    }
    receiver.recv_timeout(timeout).ok()
}

/// A promise is safe only when the main run loop can answer it now.
#[cfg(target_os = "macos")]
fn main_run_loop_responds() -> bool {
    run_on_main_run_loop(|| (), std::time::Duration::from_millis(50)).is_some()
}

#[cfg(target_os = "macos")]
mod dictation_paste_provider {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_app_kit::{
        NSPasteboard, NSPasteboardItem, NSPasteboardItemDataProvider, NSPasteboardType,
    };
    use objc2_foundation::NSString;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    pub(super) struct Ivars {
        text: String,
        requested: Arc<AtomicBool>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "PlainsongDictationPasteProvider"]
        #[ivars = Ivars]
        pub(super) struct DictationPasteProvider;

        unsafe impl NSObjectProtocol for DictationPasteProvider {}

        unsafe impl NSPasteboardItemDataProvider for DictationPasteProvider {
            #[unsafe(method(pasteboard:item:provideDataForType:))]
            fn provide_data(
                &self,
                _pasteboard: Option<&NSPasteboard>,
                item: &NSPasteboardItem,
                data_type: &NSPasteboardType,
            ) {
                self.ivars().requested.store(true, Ordering::SeqCst);
                item.setString_forType(&NSString::from_str(&self.ivars().text), data_type);
            }
        }
    );

    impl DictationPasteProvider {
        pub(super) fn new(text: &str, requested: Arc<AtomicBool>) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars {
                text: text.to_string(),
                requested,
            });
            unsafe { msg_send![super(this), init] }
        }
    }
}

/// Plainsong's staged item. With `requested`, the text is promised rather than
/// written, so the flag records whether anything asked for it.
#[cfg(target_os = "macos")]
fn staged_dictation_item(
    text: &str,
    requested: Option<&Arc<AtomicBool>>,
) -> Option<objc2::rc::Retained<objc2_app_kit::NSPasteboardItem>> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSData, NSString};

    let item = NSPasteboardItem::new();
    let text_type = unsafe { NSPasteboardTypeString };
    let staged = match requested {
        Some(requested) => {
            // The pasteboard retains the provider until it no longer needs it.
            let provider =
                dictation_paste_provider::DictationPasteProvider::new(text, Arc::clone(requested));
            item.setDataProvider_forTypes(
                ProtocolObject::from_ref(&*provider),
                &NSArray::from_slice(&[text_type]),
            )
        }
        None => item.setString_forType(&NSString::from_str(text), text_type),
    };
    (staged
        && staged_dictation_marker_types()
            .into_iter()
            .all(|marker| item.setData_forType(&NSData::new(), &NSString::from_str(marker))))
    .then_some(item)
}

#[cfg(target_os = "macos")]
fn write_staged_dictation_item(item: &objc2_app_kit::NSPasteboardItem) -> (isize, bool) {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSArray;

    let pasteboard = NSPasteboard::generalPasteboard();
    let cleared_change_count = pasteboard.clearContents();
    let written = pasteboard.writeObjects(&NSArray::from_slice(&[ProtocolObject::from_ref(item)]));
    (cleared_change_count, written)
}

/// Stages the dictated text and, when the main run loop can serve a promise,
/// returns the flag that records whether any app requested it.
#[cfg(target_os = "macos")]
fn stage_macos_clipboard_text(
    snapshot: Option<&ClipboardSnapshot>,
    text: &str,
) -> Result<(isize, Option<Arc<AtomicBool>>), String> {
    let requested = main_run_loop_responds().then(|| Arc::new(AtomicBool::new(false)));
    let item = staged_dictation_item(text, requested.as_ref());
    if snapshot
        .is_some_and(|snapshot| macos_clipboard_change_count() != snapshot.source_change_count)
    {
        return Err("The clipboard changed before Plainsong could stage the paste.".to_string());
    }
    let Some(item) = item else {
        return Err("The macOS pasteboard rejected the staged text.".to_string());
    };
    let (cleared_change_count, written) = write_staged_dictation_item(&item);
    if !written {
        let staging_error = "The macOS pasteboard rejected the staged text.".to_string();
        return Err(match snapshot {
            Some(snapshot) => recover_after_failed_stage(
                snapshot,
                cleared_change_count,
                staging_error,
                restore_macos_clipboard_if_owned,
            ),
            None => staging_error,
        });
    }
    Ok((macos_clipboard_change_count(), requested))
}

/// Replaces an unrequested promise with the text itself, so a manual paste
/// still works if the sidecar exits. Returns whether the text is on the
/// clipboard; a copy the user made in the meantime is left alone.
#[cfg(target_os = "macos")]
fn retain_unrequested_macos_clipboard_text(text: &str, owned_change_count: isize) -> bool {
    if macos_clipboard_change_count() != owned_change_count {
        return false;
    }
    staged_dictation_item(text, None).is_some_and(|item| write_staged_dictation_item(&item).1)
}

#[cfg(any(test, target_os = "macos"))]
fn recover_after_failed_stage<Snapshot, Restore>(
    snapshot: &Snapshot,
    owned_change_count: isize,
    staging_error: String,
    restore: Restore,
) -> String
where
    Restore: FnOnce(&Snapshot, isize) -> Result<bool, String>,
{
    match restore(snapshot, owned_change_count) {
        Ok(true) => staging_error,
        Ok(false) => format!(
            "{} The original clipboard was not restored because ownership changed.",
            staging_error
        ),
        Err(error) => format!(
            "{} Restoring the original clipboard also failed: {}",
            staging_error, error
        ),
    }
}

#[cfg(target_os = "macos")]
fn macos_clipboard_change_count() -> isize {
    objc2_app_kit::NSPasteboard::generalPasteboard().changeCount()
}

#[cfg(test)]
fn restore_snapshot_if_owned<Snapshot, ChangeCount, Restore>(
    snapshot: &Snapshot,
    owned_change_count: isize,
    change_count: ChangeCount,
    restore: Restore,
) -> Result<bool, String>
where
    ChangeCount: FnOnce() -> isize,
    Restore: FnOnce(&Snapshot) -> Result<(), String>,
{
    if change_count() != owned_change_count {
        return Ok(false);
    }
    restore(snapshot)?;
    Ok(true)
}

#[cfg(any(test, target_os = "macos"))]
fn prepare_and_restore_snapshot_if_owned<Snapshot, Prepared, Prepare, ChangeCount, Restore>(
    snapshot: &Snapshot,
    owned_change_count: isize,
    prepare: Prepare,
    change_count: ChangeCount,
    restore: Restore,
) -> Result<bool, String>
where
    Prepare: FnOnce(&Snapshot) -> Result<Prepared, String>,
    ChangeCount: FnOnce() -> isize,
    Restore: FnOnce(Prepared) -> Result<(), String>,
{
    let prepared = prepare(snapshot)?;
    if change_count() != owned_change_count {
        return Ok(false);
    }
    restore(prepared)?;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn restore_macos_clipboard_if_owned(
    snapshot: &ClipboardSnapshot,
    owned_change_count: isize,
) -> Result<bool, String> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSData, NSString};

    let pasteboard = NSPasteboard::generalPasteboard();
    prepare_and_restore_snapshot_if_owned(
        snapshot,
        owned_change_count,
        |snapshot| {
            if snapshot.items.is_empty() {
                return Ok(None);
            }

            let mut restored_items = Vec::with_capacity(snapshot.items.len());
            for entries in &snapshot.items {
                let item = NSPasteboardItem::new();
                for entry in entries {
                    let data_type = NSString::from_str(&entry.type_name);
                    let data = NSData::from_vec(entry.data.clone());
                    if !item.setData_forType(&data, &data_type) {
                        return Err(
                            "The macOS pasteboard rejected a preserved item type.".to_string()
                        );
                    }
                }
                restored_items.push(item);
            }
            let writing_items = restored_items
                .iter()
                .map(|item| ProtocolObject::<dyn NSPasteboardWriting>::from_ref(&**item))
                .collect::<Vec<_>>();
            let writing_items = NSArray::from_slice(&writing_items);
            Ok(Some(writing_items))
        },
        || pasteboard.changeCount(),
        |writing_items| {
            pasteboard.clearContents();
            if let Some(writing_items) = writing_items {
                if !pasteboard.writeObjects(&writing_items) {
                    return Err(
                        "The macOS pasteboard rejected the preserved clipboard items.".to_string(),
                    );
                }
            }
            record_clipboard_restore(ClipboardRestoreMark {
                restored_from: snapshot.source_change_count,
                restored_at: pasteboard.changeCount(),
            });
            Ok(())
        },
    )
}

/// Where and when Plainsong last put a preserved clipboard back. A delivery
/// that staged the words, was refused, and restored the user's clipboard moves
/// the change count; this tells that apart from the user copying something
/// during delivery, and records which clipboard the restore put back.
#[cfg(target_os = "macos")]
static LAST_CLIPBOARD_RESTORE: std::sync::Mutex<Option<ClipboardRestoreMark>> =
    std::sync::Mutex::new(None);

#[cfg(target_os = "macos")]
fn record_clipboard_restore(mark: ClipboardRestoreMark) {
    match LAST_CLIPBOARD_RESTORE.lock() {
        Ok(mut slot) => *slot = Some(mark),
        Err(poisoned) => *poisoned.into_inner() = Some(mark),
    }
}

#[cfg(target_os = "macos")]
fn last_clipboard_restore() -> Option<ClipboardRestoreMark> {
    match LAST_CLIPBOARD_RESTORE.lock() {
        Ok(slot) => *slot,
        Err(poisoned) => *poisoned.into_inner(),
    }
}

#[cfg(target_os = "macos")]
fn schedule_macos_clipboard_restore(snapshot: ClipboardSnapshot, owned_change_count: isize) {
    std::thread::spawn(move || {
        let _ = crate::qos::WorkClass::Interactive.apply_to_current_thread();
        std::thread::sleep(std::time::Duration::from_millis(
            DICTATION_PASTE_CLIPBOARD_RESTORE_DELAY_MS,
        ));
        if let Err(error) = restore_macos_clipboard_if_owned(&snapshot, owned_change_count) {
            tracing::warn!("Failed to restore preserved clipboard contents: {}", error);
        }
    });
}

#[cfg(any(test, target_os = "macos"))]
fn stage_and_dispatch_native_paste<Snapshot, SnapshotFn, Stage, ChangeCount, Dispatch, Restore>(
    text: &str,
    mut verify_target: impl FnMut() -> Result<(), PasteDispatchFailure>,
    snapshot: SnapshotFn,
    stage: Stage,
    change_count: ChangeCount,
    dispatch: Dispatch,
    restore: Restore,
) -> Result<(PasteDispatchStatus, Option<(Snapshot, isize)>), PasteDispatchFailure>
where
    SnapshotFn: FnOnce() -> Result<Snapshot, String>,
    Stage: FnOnce(Option<&Snapshot>, &str) -> Result<isize, String>,
    ChangeCount: FnOnce() -> isize,
    Dispatch: FnOnce(isize) -> Result<PasteDispatchStatus, PasteDispatchFailure>,
    Restore: FnOnce(&Snapshot, isize) -> Result<bool, String>,
{
    // Retention controls the successful outcome, not rollback. Even a retained
    // paste must preserve the old clipboard if focus becomes unsafe later.
    verify_target()?;
    let snapshot = Some(snapshot().map_err(|error| {
        PasteDispatchFailure::Refused(format!(
            "Could not snapshot the clipboard before paste: {}",
            error
        ))
    })?);
    verify_target()?;

    let owned_change_count = stage(snapshot.as_ref(), text).map_err(|error| {
        PasteDispatchFailure::Refused(format!("Failed to stage clipboard paste: {}", error))
    })?;
    if change_count() != owned_change_count {
        return Err(PasteDispatchFailure::Refused(
            "The clipboard changed before Plainsong could dispatch paste.".to_string(),
        ));
    }
    if let Err(error) = verify_target() {
        if let Some(snapshot) = snapshot.as_ref() {
            match restore(snapshot, owned_change_count) {
                Ok(true) => {}
                Ok(false) => return Err(PasteDispatchFailure::Refused(
                    "The clipboard changed before Plainsong could restore it after paste refusal."
                        .to_string(),
                )),
                Err(restore_error) => {
                    return Err(PasteDispatchFailure::Refused(format!(
                        "Could not restore the preserved clipboard after paste refusal: {}",
                        restore_error
                    )))
                }
            }
        }
        return Err(error);
    }
    match dispatch(owned_change_count) {
        Ok(status) => Ok((
            status,
            snapshot.map(|snapshot| (snapshot, owned_change_count)),
        )),
        Err(error) => {
            if let Some(snapshot) = snapshot.as_ref() {
                match restore(snapshot, owned_change_count) {
                    Ok(true) => {}
                    Ok(false) => return Err(PasteDispatchFailure::Refused(
                        "The clipboard changed before Plainsong could restore it after paste refusal.".to_string(),
                    )),
                    Err(restore_error) => return Err(PasteDispatchFailure::Refused(format!(
                        "Could not restore the preserved clipboard after paste refusal: {}", restore_error
                    ))),
                }
            }
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn send_native_copy_key(
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> Result<(), String> {
    reactivate_target_application(target_app, target_app_bundle_id)?
        .settle(std::time::Duration::from_millis(50));
    dispatch_command_keystroke(current_layout_command_keycode('c', ANSI_C_KEYCODE))
        .map_err(|error| format!("CoreGraphics copy failed: {}", error))
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

/// A read-only anchor for one paste. Recipient text stays in memory and is
/// never logged or sent to a provider.
#[cfg(target_os = "macos")]
struct PasteReadbackAnchor {
    element: AXUIElementRef,
    expected: String,
}

#[cfg(target_os = "macos")]
impl Drop for PasteReadbackAnchor {
    fn drop(&mut self) {
        unsafe { CFRelease(self.element) };
    }
}

#[cfg(target_os = "macos")]
impl PasteReadbackAnchor {
    fn capture(
        text: &str,
        target_app: Option<&str>,
        target_bundle: Option<&str>,
    ) -> Result<Option<Self>, PasteDispatchFailure> {
        let Some(element) = copy_frontmost_focused_accessibility_element(target_app, target_bundle)
            .map_err(PasteDispatchFailure::Refused)?
        else {
            return Ok(None);
        };
        if let Some(signal) = classify_focused_element_security(element) {
            unsafe { CFRelease(element) };
            return Err(PasteDispatchFailure::SecureField(signal));
        }
        let expected = (|| {
            let value = ax_copy_string_attribute(element, "AXValue")
                .ok()
                .flatten()?;
            let range = ax_copy_cf_range_attribute(element, "AXSelectedTextRange")
                .ok()
                .flatten()?;
            let (expected, _) = replace_utf16_range(&value, range, text)?;
            // An unchanged value cannot prove that the paste was received.
            (expected != value).then_some(expected)
        })();
        match expected {
            Some(expected) => Ok(Some(Self { element, expected })),
            None => {
                unsafe { CFRelease(element) };
                Ok(None)
            }
        }
    }

    fn confirm(&self, target_app: Option<&str>, target_bundle: Option<&str>) -> bool {
        use core_foundation_sys::base::CFEqual;
        for _ in 0..6 {
            let Some(current) =
                copy_frontmost_focused_accessibility_element(target_app, target_bundle)
                    .ok()
                    .flatten()
            else {
                return false;
            };
            let same = unsafe { CFEqual(current, self.element) } != 0;
            let secure = classify_focused_element_security(current).is_some();
            unsafe { CFRelease(current) };
            if !same || secure {
                return false;
            }
            if ax_copy_string_attribute(self.element, "AXValue")
                .ok()
                .flatten()
                .as_deref()
                == Some(self.expected.as_str())
            {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        false
    }
}

/// Why the native paste did not happen.
#[cfg(any(test, target_os = "macos"))]
#[derive(Debug)]
pub(crate) enum PasteDispatchFailure {
    /// The focused control, checked immediately before the clipboard was
    /// touched, is a password or other secure input. Nothing was staged.
    SecureField(dictation_secure_field::SecureFieldSignal),
    /// Target or clipboard ownership was lost. Never overwrite the clipboard
    /// or redirect a refused paste through the ordinary copy fallback.
    Refused(String),
    Other(String),
    /// Cmd+V was sent but nothing requested the staged text, so the target
    /// did not paste it. `copied` says whether the text is still on the
    /// clipboard for a manual paste.
    NotAccepted {
        copied: bool,
    },
}

#[cfg(target_os = "macos")]
fn resolve_native_paste_target(
    focused: Option<FocusedApplicationIdentity>,
    target_app: Option<&str>,
    target_bundle: Option<&str>,
) -> Result<FocusedApplicationIdentity, PasteDispatchFailure> {
    let focused = focused.ok_or_else(|| {
        PasteDispatchFailure::Refused("There is no frontmost application for paste.".to_string())
    })?;
    if !focused_application_matches_target(&focused, target_app, target_bundle) {
        return Err(PasteDispatchFailure::Refused(
            "The frontmost application no longer matches the captured dictation target."
                .to_string(),
        ));
    }
    Ok(focused)
}

#[cfg(target_os = "macos")]
fn verify_native_paste_target(
    expected: &FocusedApplicationIdentity,
    mut current: impl FnMut() -> Option<FocusedApplicationIdentity>,
    secure_field: impl FnOnce() -> Option<dictation_secure_field::SecureFieldSignal>,
) -> Result<(), PasteDispatchFailure> {
    let unchanged = |current: Option<FocusedApplicationIdentity>| {
        current
            .as_ref()
            .is_some_and(|current| focused_application_identity_unchanged(expected, current))
    };
    if !unchanged(current()) {
        return Err(PasteDispatchFailure::Refused(
            "The target application changed before paste dispatch.".to_string(),
        ));
    }
    if let Some(signal) = secure_field() {
        return Err(PasteDispatchFailure::SecureField(signal));
    }
    if !unchanged(current()) {
        return Err(PasteDispatchFailure::Refused(
            "The target application changed during the secure-field check.".to_string(),
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_staged_native_paste(
    expected: &FocusedApplicationIdentity,
    current: impl FnMut() -> Option<FocusedApplicationIdentity>,
    secure_field: impl FnOnce() -> Option<dictation_secure_field::SecureFieldSignal>,
    mut clipboard_change_count: impl FnMut() -> isize,
    owned_change_count: isize,
) -> Result<(), PasteDispatchFailure> {
    if clipboard_change_count() != owned_change_count {
        return Err(PasteDispatchFailure::Refused(
            "The clipboard changed before paste dispatch.".to_string(),
        ));
    }
    verify_native_paste_target(expected, current, secure_field)?;
    if clipboard_change_count() != owned_change_count {
        return Err(PasteDispatchFailure::Refused(
            "The clipboard changed during the paste target check.".to_string(),
        ));
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
fn dispatch_verified_native_paste(
    expected: &FocusedApplicationIdentity,
    current: impl FnMut() -> Option<FocusedApplicationIdentity>,
    secure_field: impl FnOnce() -> Option<dictation_secure_field::SecureFieldSignal>,
    dispatch: impl FnOnce() -> Result<PasteDispatchStatus, String>,
) -> Result<PasteDispatchStatus, PasteDispatchFailure> {
    verify_native_paste_target(expected, current, secure_field)?;
    dispatch().map_err(PasteDispatchFailure::Other)
}

/// How long after Cmd+V a target may take to request the promised text.
#[cfg(target_os = "macos")]
const NATIVE_PASTE_REQUEST_WINDOW: std::time::Duration = std::time::Duration::from_millis(1_000);

#[cfg(any(test, target_os = "macos"))]
fn wait_for_paste_request(requested: &AtomicBool, deadline: std::time::Instant) -> bool {
    loop {
        if requested.load(Ordering::SeqCst) {
            return true;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep((deadline - now).min(std::time::Duration::from_millis(10)));
    }
}

/// `paste_requested` is `None` when the text was written rather than
/// promised, and otherwise reports whether anything requested it in time.
#[cfg(any(test, target_os = "macos"))]
fn finish_native_paste_readback<Snapshot>(
    preservation: Option<(Snapshot, isize)>,
    keep_text_in_clipboard: bool,
    confirm: impl FnOnce() -> bool,
    paste_requested: impl FnOnce() -> Option<bool>,
    retain_unrequested_text: impl FnOnce(isize) -> bool,
    clipboard_change_count: impl FnOnce() -> isize,
    schedule_restore: impl FnOnce(Snapshot, isize),
) -> Result<(bool, bool), PasteDispatchFailure> {
    let confirmed = confirm();
    if !confirmed && paste_requested() == Some(false) {
        // Leave the text for a manual paste instead of restoring. Pasting
        // again automatically could land in a different field.
        let copied = preservation
            .as_ref()
            .is_some_and(|(_, owned)| retain_unrequested_text(*owned));
        return Err(PasteDispatchFailure::NotAccepted { copied });
    }
    let copied = keep_text_in_clipboard
        && preservation
            .as_ref()
            .is_some_and(|(_, owned)| clipboard_change_count() == *owned);
    if !keep_text_in_clipboard {
        if let Some((snapshot, owned)) = preservation {
            schedule_restore(snapshot, owned);
        }
    }
    Ok((confirmed, copied))
}

#[cfg(target_os = "macos")]
fn dispatch_paste_from_clipboard_owned(
    text: &str,
    keep_text_in_clipboard: bool,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
    expected_field: Option<&DeliveryFieldFingerprint>,
    selection: Option<&PreparedDictationSelectedContext>,
) -> Result<(CursorInsertStrategy, bool, bool, bool), PasteDispatchFailure> {
    // Bring the target forward and look at the focused control immediately
    // before the clipboard is touched. Focus can move between any earlier
    // probe and this point (the direct-write attempt, the app coming
    // forward), and a password box that gained focus in that gap must
    // neither receive the paste nor see the words staged on the clipboard.
    // This is also the backstop for callers that never looked at the
    // focused element at all.
    reactivate_target_application(target_app, target_app_bundle_id)
        .map_err(PasteDispatchFailure::Refused)?
        .settle(std::time::Duration::from_millis(50));
    let expected_focus = resolve_native_paste_target(
        frontmost_application_identity(),
        target_app,
        target_app_bundle_id,
    )?;
    if let Some(signal) = probe_focused_secure_field() {
        return Err(PasteDispatchFailure::SecureField(signal));
    }
    guard_delivery_field(expected_field, target_app, target_app_bundle_id)
        .map_err(PasteDispatchFailure::Refused)?;

    let readback = PasteReadbackAnchor::capture(text, target_app, target_app_bundle_id)?;
    // Recheck after anchoring: protected focus may have changed during reads.
    if let Some(signal) = probe_focused_secure_field() {
        return Err(PasteDispatchFailure::SecureField(signal));
    }
    let paste_requested = std::cell::Cell::new(None);
    match stage_and_dispatch_native_paste(
        text,
        || {
            if selection.is_some_and(|guard| !guard.verify_original_selection()) {
                return Err(PasteDispatchFailure::Refused(
                    DICTATION_FOCUS_CHANGED_MESSAGE.into(),
                ));
            }
            guard_delivery_field(expected_field, target_app, target_app_bundle_id)
                .map_err(PasteDispatchFailure::Refused)?;
            verify_native_paste_target(
                &expected_focus,
                frontmost_application_identity,
                probe_focused_secure_field,
            )
        },
        snapshot_macos_clipboard,
        |snapshot, text| {
            let (owned, requested) = stage_macos_clipboard_text(snapshot, text)?;
            paste_requested.set(requested);
            Ok(owned)
        },
        macos_clipboard_change_count,
        |owned| {
            if selection.is_some_and(|guard| !guard.verify_original_selection()) {
                return Err(PasteDispatchFailure::Refused(
                    DICTATION_FOCUS_CHANGED_MESSAGE.into(),
                ));
            }
            send_native_paste_key(&expected_focus, owned, expected_field, selection)
        },
        restore_macos_clipboard_if_owned,
    ) {
        Ok((_status, preservation)) => {
            let deadline = std::time::Instant::now() + NATIVE_PASTE_REQUEST_WINDOW;
            let requested_in_time = std::cell::Cell::new(false);
            let (confirmed, copied) = finish_native_paste_readback(
                preservation,
                keep_text_in_clipboard,
                || {
                    readback
                        .as_ref()
                        .is_some_and(|anchor| anchor.confirm(target_app, target_app_bundle_id))
                },
                || {
                    let requested = paste_requested
                        .take()
                        .map(|requested| wait_for_paste_request(&requested, deadline));
                    requested_in_time.set(requested == Some(true));
                    requested
                },
                |owned| retain_unrequested_macos_clipboard_text(text, owned),
                macos_clipboard_change_count,
                schedule_macos_clipboard_restore,
            )?;
            Ok((
                CursorInsertStrategy::SimulatedTyping,
                confirmed,
                copied,
                requested_in_time.get(),
            ))
        }
        Err(PasteDispatchFailure::Other(error)) => Err(PasteDispatchFailure::Other(
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
        )),
        Err(refusal) => Err(refusal),
    }
}

#[cfg(any(test, target_os = "macos"))]
fn capture_selection_preserving_clipboard<Snapshot>(
    snapshot: impl FnOnce() -> Result<Snapshot, String>,
    stage: impl FnOnce(&Snapshot, &str) -> Result<isize, String>,
    copy: impl FnOnce() -> Result<(), String>,
    mut read: impl FnMut() -> Result<(isize, String), String>,
    restore: impl FnOnce(&Snapshot, isize) -> Result<bool, String>,
) -> Result<Option<String>, String> {
    let original = snapshot()?;
    let sentinel = format!("__plainsong_selection_{}__", uuid::Uuid::new_v4());
    let staged_count = stage(&original, &sentinel)?;
    let mut owned_count = staged_count;
    let result = copy().map(|()| {
        for _ in 0..6 {
            if let Ok((count, text)) = read() {
                if count != staged_count && text != sentinel {
                    owned_count = count;
                    return Some(text.trim().to_string()).filter(|text| !text.is_empty());
                }
            }
        }
        None
    });
    // A successful Cmd+C owns the captured value only until another copy.
    // The native restorer rechecks ownership after preparing every data type.
    restore(&original, owned_count)?;
    result
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
    reactivate_target_application(target_app, None)?.settle(std::time::Duration::from_millis(35));
    if let Some(signal) = probe_focused_secure_field() {
        return Err(dictation_secure_field::secure_field_capture_refusal_message(signal));
    }

    capture_selection_preserving_clipboard(
        snapshot_macos_clipboard,
        |snapshot, sentinel| {
            stage_macos_clipboard_text(Some(snapshot), sentinel).map(|(owned, _)| owned)
        },
        || send_native_copy_key(target_app, None),
        || {
            std::thread::sleep(std::time::Duration::from_millis(45));
            let change_count = macos_clipboard_change_count();
            let text = read_clipboard_text()?;
            if macos_clipboard_change_count() != change_count {
                return Err("The clipboard changed while Plainsong read the selection.".to_string());
            }
            Ok((change_count, text))
        },
        restore_macos_clipboard_if_owned,
    )
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

#[cfg(target_os = "macos")]
pub(crate) fn delivery_refusal_outcome(error: String) -> PasteOutcome {
    PasteOutcome {
        pasted: false,
        copied: false,
        direct_accessibility: false,
        confirmed: false,
        paste_requested: false,
        successful_strategy: None,
        secure_field: None,
        error: Some(error),
    }
}

/// Shared by the live fallback and its fake-clipboard tests. A refusal must
/// survive this outer layer without turning into another clipboard write.
#[cfg(target_os = "macos")]
fn native_paste_outcome(
    text: &str,
    keep_text_in_clipboard: bool,
    result: Result<(CursorInsertStrategy, bool, bool), PasteDispatchFailure>,
    copy: impl FnOnce(&str) -> Result<(), String>,
) -> PasteOutcome {
    match result {
        Ok((strategy, confirmed, retained)) => {
            let copied = keep_text_in_clipboard && retained;
            PasteOutcome {
                pasted: true,
                copied,
                direct_accessibility: false,
                confirmed,
                paste_requested: false,
                successful_strategy: Some(strategy),
                secure_field: None,
                error: None,
            }
        }
        Err(PasteDispatchFailure::SecureField(signal)) => secure_field_refusal_outcome(signal),
        Err(PasteDispatchFailure::Refused(error)) => delivery_refusal_outcome(error),
        Err(PasteDispatchFailure::NotAccepted { copied }) => PasteOutcome {
            pasted: false,
            copied,
            direct_accessibility: false,
            confirmed: false,
            paste_requested: false,
            successful_strategy: None,
            secure_field: None,
            error: Some(
                if copied {
                    "Plainsong couldn't confirm the paste. If the text isn't there, press the paste-last shortcut or Cmd+V."
                } else {
                    "Plainsong couldn't confirm the paste. If the text isn't there, press the paste-last shortcut."
                }
                .to_string(),
            ),
        },
        Err(PasteDispatchFailure::Other(error)) => match copy(text) {
            Ok(()) => PasteOutcome {
                pasted: false,
                copied: true,
                direct_accessibility: false,
                confirmed: false,
                paste_requested: false,
                successful_strategy: None,
                secure_field: None,
                error: Some(format!("Copied to clipboard. {}", error)),
            },
            Err(copy_error) => delivery_refusal_outcome(format!(
                "{} Clipboard copy also failed: {}",
                error, copy_error
            )),
        },
    }
}

pub(crate) struct OriginalAutoDelivery {
    field: Option<DeliveryFieldFingerprint>,
}

impl OriginalAutoDelivery {
    pub(crate) fn capture(field: Option<&DeliveryFieldFingerprint>) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        if !field.is_some_and(DeliveryFieldFingerprint::usable) {
            return Err("The original dictation field could not be verified. Your words are ready to copy in Plainsong.".into());
        }
        Ok(Self {
            field: field.cloned(),
        })
    }
}

#[cfg(test)]
mod automatic_target_policy_tests {
    use super::*;

    fn restore(restored_from: isize, restored_at: isize) -> Option<ClipboardRestoreMark> {
        Some(ClipboardRestoreMark {
            restored_from,
            restored_at,
        })
    }

    #[test]
    fn a_clipboard_plainsong_restored_still_counts_as_untouched() {
        // Never touched.
        assert!(clipboard_unchanged_by_others(Some(7), Some(7), None));
        // Staged, refused, and put back the clipboard that was there at 7.
        assert!(clipboard_unchanged_by_others(
            Some(7),
            Some(9),
            restore(7, 9)
        ));
        // The user copied something during delivery; theirs survives.
        assert!(!clipboard_unchanged_by_others(Some(7), Some(8), None));
        assert!(!clipboard_unchanged_by_others(
            Some(7),
            Some(10),
            restore(7, 9)
        ));
        // No pasteboard to ask (non-macOS): nothing to protect.
        assert!(clipboard_unchanged_by_others(None, None, None));
    }

    #[test]
    fn a_restore_of_the_users_newer_copy_is_not_untouched() {
        // A at 7 when delivery began; the user copied B (8); Plainsong
        // snapshotted B, staged the words (9), was refused, and restored B
        // (10). The last write is Plainsong's, but it put back the user's
        // newer copy, so a fallback copy must not replace it.
        assert!(!clipboard_unchanged_by_others(
            Some(7),
            Some(10),
            restore(8, 10)
        ));
        // A restore with no baseline to trace it to proves nothing either.
        assert!(!clipboard_unchanged_by_others(
            None,
            Some(10),
            restore(8, 10)
        ));
    }

    #[test]
    fn a_quit_target_is_not_reported_as_running() {
        assert!(lsappinfo_find_reports_running(
            "ASN:0x0-0x27027-\"Finder\":\n"
        ));
        // `lsappinfo find` prints a blank line when nothing matches.
        assert!(!lsappinfo_find_reports_running("\n"));
        assert!(!lsappinfo_find_reports_running(""));
    }

    #[test]
    fn reactivation_checks_the_target_is_running_before_open() {
        let source = include_str!("text_insert.rs");
        let start = source
            .find("pub(crate) fn reactivate_target_application(")
            .expect("reactivation exists");
        let body = &source[start..];
        let running = body
            .find("target_application_is_running(")
            .expect("reactivation checks the target is running");
        let open = body
            .find("Command::new(\"/usr/bin/open\")")
            .expect("reactivation uses open");
        assert!(
            running < open,
            "check the app is running before `open` can launch it"
        );
    }

    #[test]
    fn plainsong_in_front_brings_the_dictation_target_back() {
        // A click on the pill's Stop button or the menu bar item.
        assert!(should_restore_target_before_delivery(
            Some("Plainsong"),
            Some(APP_BUNDLE_IDENTIFIER),
            Some("Notes"),
            Some("com.apple.Notes"),
        ));
        assert!(should_restore_target_before_delivery(
            None,
            Some(APP_BUNDLE_IDENTIFIER),
            None,
            Some("com.apple.Notes"),
        ));
        // A notification banner or Control Center briefly in front.
        assert!(should_restore_target_before_delivery(
            Some("NotificationCenter"),
            Some("com.apple.notificationcenterui"),
            Some("Slack"),
            Some("com.tinyspeck.slackmacgap"),
        ));
    }

    #[test]
    fn another_app_in_front_is_never_pulled_back() {
        // The user switched apps on purpose; that keeps the refusal.
        assert!(!should_restore_target_before_delivery(
            Some("Safari"),
            Some("com.apple.Safari"),
            Some("Notes"),
            Some("com.apple.Notes"),
        ));
        // Already in front: nothing to restore.
        assert!(!should_restore_target_before_delivery(
            Some("Notes"),
            Some("com.apple.Notes"),
            Some("Notes"),
            Some("com.apple.Notes"),
        ));
    }

    #[test]
    fn no_known_target_or_self_target_never_activates_anything() {
        assert!(!should_restore_target_before_delivery(
            Some("Plainsong"),
            Some(APP_BUNDLE_IDENTIFIER),
            None,
            Some("  "),
        ));
        assert!(!should_restore_target_before_delivery(
            Some("Plainsong"),
            Some(APP_BUNDLE_IDENTIFIER),
            Some("Plainsong"),
            Some(APP_BUNDLE_IDENTIFIER),
        ));
        // Nothing readable in front: no basis for an activation.
        assert!(!should_restore_target_before_delivery(
            None,
            None,
            Some("Notes"),
            Some("com.apple.Notes"),
        ));
    }

    #[test]
    fn automatic_target_accepts_usable_original_identity() {
        let field = DeliveryFieldFingerprint {
            pid: Some(42),
            element_hash: Some(7),
            ..Default::default()
        };
        assert!(OriginalAutoDelivery::capture(Some(&field)).is_ok());
    }

    #[test]
    fn missing_automatic_target_obeys_platform_policy() {
        assert_eq!(
            OriginalAutoDelivery::capture(None).is_err(),
            cfg!(target_os = "macos")
        );
        assert_eq!(
            OriginalAutoDelivery::capture(Some(&DeliveryFieldFingerprint::default())).is_err(),
            cfg!(target_os = "macos")
        );
        assert!(validate_delivery_field_identity(None, None).is_ok());
    }
}

pub(crate) struct ManualCurrentPaste {
    app: Option<String>,
    bundle: Option<String>,
}

impl ManualCurrentPaste {
    pub(crate) fn capture_current(app: Option<String>, bundle: Option<String>) -> Self {
        Self { app, bundle }
    }
}

pub(crate) fn paste_manual_current(
    trust: &Arc<AtomicBool>,
    text: &str,
    keep: bool,
    target: ManualCurrentPaste,
) -> PasteOutcome {
    paste_text_systemwide(
        trust,
        text,
        keep,
        target.app.as_deref(),
        target.bundle.as_deref(),
    )
}

pub(crate) struct OriginalDictationDelivery {
    pub(crate) outcome: PasteOutcome,
    pub(crate) undo: Option<OwnedDictationEdit>,
}

#[derive(Clone)]
pub(crate) struct OwnedDictationEdit {
    #[cfg(target_os = "macos")]
    field: DeliveryFieldFingerprint,
    #[cfg(target_os = "macos")]
    requests: std::sync::mpsc::SyncSender<UndoRequest>,
}
impl std::fmt::Debug for OwnedDictationEdit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OwnedDictationEdit { <redacted> }")
    }
}
#[cfg(target_os = "macos")]
struct UndoRequest {
    action: Option<crate::dictation_parity::DictationCommandAction>,
    deadline: std::time::Instant,
    expected: Option<DeliveryFieldFingerprint>,
    reply: std::sync::mpsc::SyncSender<Result<bool, String>>,
}

pub(crate) fn undo_owned_dictation_edit(
    edit: OwnedDictationEdit,
    expected_field: Option<&DeliveryFieldFingerprint>,
) -> Result<bool, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (edit, expected_field);
        Err("Safe dictation undo is not supported on this platform.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let (reply, result) = std::sync::mpsc::sync_channel(1);
        edit.requests
            .try_send(UndoRequest {
                action: None,
                deadline: std::time::Instant::now() + std::time::Duration::from_millis(750),
                expected: expected_field.cloned(),
                reply,
            })
            .map_err(|_| "This dictation can no longer be undone safely.".to_string())?;
        result
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_else(|_| {
                Err(
                    "Undo could not be verified. Check the field before making another change."
                        .into(),
                )
            })
    }
}

pub(crate) fn paste_original_dictation(
    trust: &Arc<AtomicBool>,
    text: &str,
    keep: bool,
    app: Option<&str>,
    bundle: Option<&str>,
    target: OriginalAutoDelivery,
    #[cfg(target_os = "macos")] selection: Option<Arc<PreparedDictationSelectedContext>>,
) -> OriginalDictationDelivery {
    #[cfg(target_os = "macos")]
    {
        let trust = Arc::clone(trust);
        let text = text.to_owned();
        let app = app.map(str::to_owned);
        let bundle = bundle.map(str::to_owned);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut captured = None;
            let outcome = paste_text_systemwide_inner(
                &trust,
                &text,
                keep,
                PasteTarget {
                    app: app.as_deref(),
                    bundle_id: bundle.as_deref(),
                },
                target.field.as_ref(),
                selection.as_deref(),
                Some(&mut captured),
            );
            drop(selection);
            let Some(captured) = captured else {
                let _ = sender.send(OriginalDictationDelivery {
                    outcome,
                    undo: None,
                });
                return;
            };
            let (requests, receiver) = std::sync::mpsc::sync_channel(1);
            if sender
                .send(OriginalDictationDelivery {
                    outcome,
                    undo: Some(OwnedDictationEdit {
                        requests,
                        field: captured.fingerprint.clone(),
                    }),
                })
                .is_ok()
            {
                serve_voice_edit(captured, receiver);
            }
        });
        // Wait through insertion completion. Returning early could trigger a duplicate fallback.
        receiver
            .recv()
            .unwrap_or_else(|_| OriginalDictationDelivery {
                outcome: PasteOutcome {
                    pasted: true,
                    copied: false,
                    direct_accessibility: false,
                    confirmed: false,
                    paste_requested: false,
                    successful_strategy: None,
                    secure_field: None,
                    error: Some(
                        "Insertion could not be verified. Check the field before inserting again."
                            .into(),
                    ),
                },
                undo: None,
            })
    }
    #[cfg(not(target_os = "macos"))]
    {
        OriginalDictationDelivery {
            outcome: paste_text_systemwide_inner(
                trust,
                text,
                keep,
                PasteTarget {
                    app,
                    bundle_id: bundle,
                },
                target.field.as_ref(),
            ),
            undo: None,
        }
    }
}

pub(crate) fn paste_text_systemwide(
    accessibility_trust_observed: &Arc<AtomicBool>,
    text: &str,
    keep_text_in_clipboard: bool,
    target_app: Option<&str>,
    target_app_bundle_id: Option<&str>,
) -> PasteOutcome {
    paste_text_systemwide_inner(
        accessibility_trust_observed,
        text,
        keep_text_in_clipboard,
        PasteTarget {
            app: target_app,
            bundle_id: target_app_bundle_id,
        },
        None,
        #[cfg(target_os = "macos")]
        None,
        #[cfg(target_os = "macos")]
        None,
    )
}

struct PasteTarget<'a> {
    app: Option<&'a str>,
    bundle_id: Option<&'a str>,
}

fn paste_text_systemwide_inner(
    accessibility_trust_observed: &Arc<AtomicBool>,
    text: &str,
    keep_text_in_clipboard: bool,
    target: PasteTarget<'_>,
    expected_field: Option<&DeliveryFieldFingerprint>,
    #[cfg(target_os = "macos")] selection: Option<&PreparedDictationSelectedContext>,
    #[cfg(target_os = "macos")] owned_edit: Option<&mut Option<AxOwnedDictationEdit>>,
) -> PasteOutcome {
    let PasteTarget {
        app: target_app,
        bundle_id: target_app_bundle_id,
    } = target;
    tracing::info!("paste_text_systemwide called with {} chars", text.len());

    #[cfg(target_os = "macos")]
    {
        let (target_app, target_app_bundle_id) =
            if is_self_activation_target(target_app, target_app_bundle_id) {
                (None, None)
            } else {
                (target_app, target_app_bundle_id)
            };

        if selection.is_some_and(|guard| !guard.verify_original_selection()) {
            return delivery_refusal_outcome(DICTATION_FOCUS_CHANGED_MESSAGE.into());
        }
        match insert_text_via_accessibility_owned(
            text,
            target_app,
            target_app_bundle_id,
            expected_field,
            selection,
            owned_edit,
        ) {
            Ok(confirmed) => {
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
                tracing::info!(confirmed, "Accessibility text insertion accepted");
                return PasteOutcome {
                    pasted: true,
                    copied,
                    direct_accessibility: true,
                    confirmed,
                    paste_requested: false,
                    successful_strategy: Some(CursorInsertStrategy::AccessibilityDirectText),
                    secure_field: None,
                    error: (!confirmed).then(|| "Text was sent, but the field change could not be verified. Check the target before inserting again.".to_string()),
                };
            }
            Err(AccessibilityInsertFailure::SecureField(signal)) => {
                return secure_field_refusal_outcome(signal);
            }
            Err(AccessibilityInsertFailure::TargetChanged(error)) => {
                return delivery_refusal_outcome(error);
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
        if selection.is_some_and(|guard| !guard.verify_original_selection()) {
            return delivery_refusal_outcome(DICTATION_FOCUS_CHANGED_MESSAGE.into());
        }
        let mut paste_requested = false;
        let result = dispatch_paste_from_clipboard_owned(
            text,
            keep_text_in_clipboard,
            target_app,
            target_app_bundle_id,
            expected_field,
            selection,
        )
        .map(|(strategy, confirmed, copied, requested)| {
            paste_requested = requested;
            (strategy, confirmed, copied)
        });
        let mut outcome =
            native_paste_outcome(text, keep_text_in_clipboard, result, copy_to_clipboard);
        outcome.paste_requested = outcome.pasted && paste_requested;
        outcome
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = expected_field;
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
                paste_requested: false,
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
                    paste_requested: false,
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
                paste_requested: false,
                successful_strategy: None,
                secure_field: None,
                error: Some(format!("Copied to clipboard. {}", error)),
            },
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod controlled_native_paste_probe {
    use super::*;

    #[test]
    #[ignore = "mutates only an explicitly launched owned QA editor and clipboard"]
    fn macos_owned_editor_paste_only() {
        let bundle = "dev.plainsong.qa-paste-editor";
        assert_eq!(get_frontmost_app_bundle_id().as_deref(), Some(bundle));
        let element = copy_frontmost_focused_accessibility_element(None, Some(bundle))
            .unwrap()
            .unwrap();
        let before = ax_copy_string_attribute(element, "AXValue")
            .unwrap()
            .unwrap();
        let identifier = ax_copy_string_attribute(element, "AXIdentifier")
            .unwrap()
            .unwrap();
        unsafe { CFRelease(element) };
        assert_eq!(before, "PUBLIC_DICTATION_TARGET\n");
        assert_eq!(identifier, "plainsong-qa-owned-text");
        let text = "Plainsong public native paste probe.";
        let outcome =
            dispatch_paste_from_clipboard_owned(text, false, None, Some(bundle), None, None);
        let (dispatched, confirmed) = match outcome {
            Ok((_, confirmed, _, _)) => (true, confirmed),
            Err(_) => (false, false),
        };
        std::thread::sleep(std::time::Duration::from_millis(1200));
        let element = copy_frontmost_focused_accessibility_element(None, Some(bundle))
            .unwrap()
            .unwrap();
        let actual = ax_copy_string_attribute(element, "AXValue")
            .unwrap()
            .unwrap();
        unsafe { CFRelease(element) };
        let received = actual == format!("{before}{text}");
        let receipt = serde_json::json!({"dispatched":dispatched,"confirmed":confirmed,"targetReceived":received,
            "postEventAccess":check_post_event_access(),"accessibilityTrusted":check_accessibility_permission()});
        let path =
            std::env::var("PLAINSONG_PASTE_PROBE_RECEIPT").expect("owned probe receipt path");
        std::fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
        println!("owned paste dispatched={dispatched} confirmed={confirmed} received={received}");
    }
}

#[cfg(target_os = "macos")]
struct UndoAxObject(CFTypeRef);
#[cfg(target_os = "macos")]
impl Drop for UndoAxObject {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}
#[cfg(target_os = "macos")]
fn undo_range(range: CFRange) -> Option<inline_edit::TextRange> {
    Some(inline_edit::TextRange {
        location: usize::try_from(range.location).ok()?,
        length: usize::try_from(range.length).ok()?,
    })
}
/// Raw operations on the one retained field. Identity policy stays in
/// `UndoBackend`, so a fake field can exercise it without Accessibility.
#[cfg(target_os = "macos")]
trait RetainedField {
    /// Identity of the focused element while it is still the retained
    /// element of the frontmost app and is not secure; otherwise `None`.
    fn focused_identity(
        &mut self,
        deadline: std::time::Instant,
    ) -> Option<DeliveryFieldFingerprint>;
    fn copy_string(&mut self, attribute: &str, deadline: std::time::Instant) -> Option<String>;
    fn selected_range(&mut self, deadline: std::time::Instant) -> Option<inline_edit::TextRange>;
    fn select(&mut self, range: inline_edit::TextRange, deadline: std::time::Instant) -> bool;
    /// `false` only when nothing was dispatched. Once sent, even an AX error
    /// can mean the editor accepted the text.
    fn write_selected_text(&mut self, text: &str, deadline: std::time::Instant) -> bool;
}
#[cfg(target_os = "macos")]
struct AxRetainedField(UndoAxObject);
#[cfg(target_os = "macos")]
struct AxOwnedDictationEdit<F = AxRetainedField> {
    field: F,
    fingerprint: DeliveryFieldFingerprint,
    policy: Option<inline_edit::InlineInsertion>,
    history: voice_edit::History,
    poisoned: bool,
}
#[cfg(target_os = "macos")]
struct UndoBackend<'a, F> {
    field: &'a mut F,
    fingerprint: &'a DeliveryFieldFingerprint,
}
#[cfg(target_os = "macos")]
impl<F: RetainedField> AxOwnedDictationEdit<F> {
    fn reverse(
        &mut self,
        expected: Option<&DeliveryFieldFingerprint>,
        deadline: std::time::Instant,
    ) -> Result<bool, String> {
        if !expected.is_some_and(|value| value.usable() && value.same_field(&self.fingerprint)) {
            return Err(
                "The original dictation field is no longer selected. Undo was refused.".into(),
            );
        }
        if std::time::Instant::now() >= deadline {
            return Err("The dictation field changed. Undo was refused.".into());
        }
        let Some(policy) = self.policy.take() else {
            return self.apply_voice_action(
                &crate::dictation_parity::DictationCommandAction::UndoLastInsert,
                expected,
                deadline,
            );
        };
        let mut backend = UndoBackend {
            field: &mut self.field,
            fingerprint: &self.fingerprint,
        };
        match policy.reverse(&mut backend, deadline) {
            inline_edit::ReverseResult::Removed { caret_restored } => Ok(caret_restored),
            inline_edit::ReverseResult::Refused => Err("The dictation field changed. Undo was refused.".into()),
            inline_edit::ReverseResult::Uncertain => Err("Undo was sent but could not be verified. Check the field before making another change.".into()),
        }
    }
}
#[cfg(target_os = "macos")]
impl AxRetainedField {
    fn timeout(element: AXUIElementRef, deadline: std::time::Instant) -> bool {
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            return false;
        };
        !remaining.is_zero()
            && unsafe {
                AXUIElementSetMessagingTimeout(
                    element,
                    remaining
                        .min(std::time::Duration::from_millis(20))
                        .as_secs_f32(),
                ) == AX_ERROR_SUCCESS
            }
    }
}
#[cfg(target_os = "macos")]
impl RetainedField for AxRetainedField {
    fn focused_identity(
        &mut self,
        deadline: std::time::Instant,
    ) -> Option<DeliveryFieldFingerprint> {
        if !Self::timeout(self.0 .0, deadline) || secure_event_input_enabled() {
            return None;
        }
        let app = frontmost_application_identity()?;
        let application = UndoAxObject(unsafe { AXUIElementCreateApplication(app.pid) });
        if application.0.is_null() || !Self::timeout(application.0, deadline) {
            return None;
        }
        let current = ax_copy_attribute_value(application.0, "AXFocusedUIElement")
            .ok()
            .flatten()
            .map(UndoAxObject)?;
        if !Self::timeout(current.0, deadline)
            || unsafe { core_foundation_sys::base::CFEqual(current.0, self.0 .0) } == 0
            || ax_element_pid(current.0) != Some(app.pid)
            || classify_focused_element_security(current.0).is_some()
        {
            return None;
        }
        let identity = delivery_fingerprint_from_element(current.0)?;
        (identity.app_bundle_id == app.bundle_id
            && identity.app_name == app.name
            && std::time::Instant::now() < deadline)
            .then_some(identity)
    }
    fn copy_string(&mut self, attribute: &str, deadline: std::time::Instant) -> Option<String> {
        use core_foundation_sys::string::{CFStringGetCharacters, CFStringGetLength};
        if !Self::timeout(self.0 .0, deadline) {
            return None;
        }
        let value = UndoAxObject(ax_copy_attribute_value(self.0 .0, attribute).ok()??);
        if unsafe { CFGetTypeID(value.0) != CFStringGetTypeID() } {
            return None;
        }
        let length = unsafe { CFStringGetLength(value.0.cast()) };
        if !(0..=inline_edit::MAX_UTF16 as isize).contains(&length) {
            return None;
        }
        let mut units = vec![0; length as usize];
        unsafe {
            CFStringGetCharacters(
                value.0.cast(),
                CFRange {
                    location: 0,
                    length,
                },
                units.as_mut_ptr(),
            );
        }
        String::from_utf16(&units).ok()
    }
    fn selected_range(&mut self, deadline: std::time::Instant) -> Option<inline_edit::TextRange> {
        if !Self::timeout(self.0 .0, deadline) {
            return None;
        }
        undo_range(ax_copy_cf_range_attribute(self.0 .0, "AXSelectedTextRange").ok()??)
    }
    fn select(&mut self, range: inline_edit::TextRange, deadline: std::time::Instant) -> bool {
        if !Self::timeout(self.0 .0, deadline) {
            return false;
        }
        let (Ok(location), Ok(length)) = (
            isize::try_from(range.location),
            isize::try_from(range.length),
        ) else {
            return false;
        };
        ax_set_cf_range_attribute(
            self.0 .0,
            "AXSelectedTextRange",
            CFRange { location, length },
        )
        .is_ok()
    }
    fn write_selected_text(&mut self, text: &str, deadline: std::time::Instant) -> bool {
        if !Self::timeout(self.0 .0, deadline) {
            return false;
        }
        let _ = ax_set_string_attribute(self.0 .0, "AXSelectedText", text);
        true
    }
}
#[cfg(target_os = "macos")]
impl<F: RetainedField> UndoBackend<'_, F> {
    /// The focused field's identity, only while it is still the retained
    /// field. Its frame may differ: auto-growing fields resize as text changes.
    fn current_identity(
        &mut self,
        deadline: std::time::Instant,
    ) -> Option<DeliveryFieldFingerprint> {
        self.field
            .focused_identity(deadline)
            .filter(|current| current.same_field(self.fingerprint))
    }
    fn valid(&mut self, deadline: std::time::Instant) -> bool {
        self.current_identity(deadline).is_some() && std::time::Instant::now() < deadline
    }
    fn string(&mut self, attribute: &str, deadline: std::time::Instant) -> Option<String> {
        if !self.valid(deadline) {
            return None;
        }
        let value = self.field.copy_string(attribute, deadline)?;
        (std::time::Instant::now() < deadline).then_some(value)
    }
}
#[cfg(target_os = "macos")]
impl<F: RetainedField> inline_edit::Backend for UndoBackend<'_, F> {
    fn read_state(
        &mut self,
        deadline: std::time::Instant,
    ) -> Option<(String, inline_edit::TextRange)> {
        let value = self.string("AXValue", deadline)?;
        if !self.valid(deadline) {
            return None;
        }
        let range = self.field.selected_range(deadline)?;
        (std::time::Instant::now() < deadline).then_some((value, range))
    }
    fn read_selected_text(&mut self, deadline: std::time::Instant) -> Option<String> {
        self.string("AXSelectedText", deadline)
    }
    fn set_range(&mut self, range: inline_edit::TextRange, deadline: std::time::Instant) -> bool {
        self.valid(deadline)
            && self.field.select(range, deadline)
            && std::time::Instant::now() < deadline
    }
    fn delete_selected_text(&mut self, deadline: std::time::Instant) -> inline_edit::Deletion {
        if !self.valid(deadline) || !self.field.write_selected_text("", deadline) {
            return inline_edit::Deletion::Refused;
        }
        inline_edit::Deletion::Accepted
    }
}

#[cfg(all(test, target_os = "macos"))]
mod owned_undo_target_tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn fingerprint(hash: u64) -> DeliveryFieldFingerprint {
        DeliveryFieldFingerprint {
            pid: Some(42),
            element_hash: Some(hash),
            ..Default::default()
        }
    }

    fn edit() -> AxOwnedDictationEdit {
        AxOwnedDictationEdit {
            // Invalid native state makes these tests fail if refusal reaches AX.
            field: AxRetainedField(UndoAxObject(std::ptr::null())),
            fingerprint: fingerprint(7),
            poisoned: false,
            history: voice_edit::History::new(voice_edit::Image {
                text: "aXb".into(),
                selection: inline_edit::TextRange {
                    location: 2,
                    length: 0,
                },
            })
            .unwrap(),
            policy: Some(
                inline_edit::InlineInsertion::capture(
                    "ab",
                    inline_edit::TextRange {
                        location: 1,
                        length: 0,
                    },
                    "X",
                    "aXb",
                    inline_edit::TextRange {
                        location: 2,
                        length: 0,
                    },
                )
                .unwrap(),
            ),
        }
    }

    #[test]
    fn mismatched_missing_and_unusable_command_fields_refuse_before_native_access() {
        for expected in [
            Some(fingerprint(8)),
            None,
            Some(DeliveryFieldFingerprint::default()),
        ] {
            assert_eq!(
                edit().reverse(expected.as_ref(), Instant::now() + Duration::from_secs(1)),
                Err("The original dictation field is no longer selected. Undo was refused.".into())
            );
        }
    }

    #[test]
    fn expired_channels_restart_only_undispatched_fresh_targets_once() {
        use crate::dictation_parity::DictationCommandAction as Action;
        let request = |action| {
            let (reply, _) = std::sync::mpsc::sync_channel(1);
            UndoRequest {
                action: Some(action),
                expected: Some(fingerprint(7)),
                deadline: Instant::now() + Duration::from_secs(1),
                reply,
            }
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        drop(receiver);
        assert!(
            send_voice_edit_request(&sender, request(Action::SelectPhrase("x".into())), true)
                .unwrap()
                .is_some()
        );
        assert!(
            send_voice_edit_request(&sender, request(Action::SelectPhrase("x".into())), false)
                .is_err()
        );
        for action in [
            Action::DeleteThat,
            Action::DeleteLastSentence,
            Action::UndoLastInsert,
            Action::ReplaceEntireSelection("text".into()),
        ] {
            assert!(send_voice_edit_request(&sender, request(action), true).is_err());
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        assert!(
            send_voice_edit_request(&sender, request(Action::MoveToEnd), true)
                .unwrap()
                .is_none()
        );
        assert!(send_voice_edit_request(&sender, request(Action::MoveToStart), true).is_err());
        assert_eq!(receiver.try_recv().unwrap().action, Some(Action::MoveToEnd));
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn only_explicit_selection_movement_or_insertion_can_start_a_new_target() {
        use crate::dictation_parity::DictationCommandAction as Action;
        assert!(voice_edit_starts_target(&Action::SelectPhrase(
            "target".into()
        )));
        assert!(voice_edit_starts_target(&Action::MoveToStart));
        assert!(voice_edit_starts_target(&Action::MoveToEnd));
        assert!(voice_edit_starts_target(&Action::InsertText("\n".into())));
        for action in [
            Action::DeleteThat,
            Action::DeleteLastSentence,
            Action::UndoLastInsert,
            Action::DeleteSelection,
            Action::UppercaseSelection,
            Action::ReplaceEntireSelection("text".into()),
        ] {
            assert!(!voice_edit_starts_target(&action));
        }
    }

    #[test]
    fn native_edit_routing_preserves_clipboard_and_application_context_commands() {
        use crate::dictation_parity::DictationCommandAction as Action;
        for action in [
            Action::UppercaseSelection,
            Action::AppendToSelection("today".into()),
            Action::InsertText("\n".into()),
        ] {
            assert!(voice_edit_uses_native_field(
                &action,
                "selected_text",
                "auto"
            ));
            assert!(!voice_edit_uses_native_field(
                &action,
                "selected_text",
                "clipboard_only"
            ));
            assert!(!voice_edit_uses_native_field(&action, "clipboard", "auto"));
            assert!(!voice_edit_uses_native_field(
                &action,
                "application_context",
                "auto"
            ));
        }
        assert!(voice_edit_uses_native_field(
            &Action::DeleteLastSentence,
            "clipboard",
            "auto"
        ));
    }

    #[test]
    fn voice_edits_refuse_changed_app_field_missing_identity_and_expired_requests_before_ax() {
        use crate::dictation_parity::DictationCommandAction as Action;
        let mut changed_app = fingerprint(7);
        changed_app.app_bundle_id = Some("different.app".into());
        let mut changed_pid = fingerprint(7);
        changed_pid.pid = Some(43);
        for expected in [
            None,
            Some(fingerprint(8)),
            Some(changed_app),
            Some(changed_pid),
            Some(DeliveryFieldFingerprint::default()),
        ] {
            for action in [
                Action::DeleteThat,
                Action::DeleteLastSentence,
                Action::SelectPhrase("x".into()),
                Action::MoveToEnd,
                Action::UndoLastInsert,
            ] {
                assert!(edit()
                    .apply_voice_action(
                        &action,
                        expected.as_ref(),
                        Instant::now() + Duration::from_secs(1)
                    )
                    .is_err());
            }
        }
        assert!(edit()
            .apply_voice_action(&Action::DeleteThat, Some(&fingerprint(7)), Instant::now())
            .is_err());
    }

    #[test]
    fn expired_matching_request_refuses_before_native_access() {
        assert_eq!(
            edit().reverse(Some(&fingerprint(7)), Instant::now()),
            Err("The dictation field changed. Undo was refused.".into())
        );
    }

    /// A chat composer that grows a line taller for each line of text.
    struct GrowingField {
        text: String,
        selection: inline_edit::TextRange,
        identity: DeliveryFieldFingerprint,
    }

    fn composer(height: i64) -> DeliveryFieldFingerprint {
        DeliveryFieldFingerprint {
            pid: Some(42),
            element_hash: Some(7),
            role: Some("AXTextArea".into()),
            identifier: Some("composer".into()),
            frame: Some(dictation_correction_capture::FocusedFieldFrame {
                x: 10,
                y: 20,
                width: 300,
                height,
            }),
            app_bundle_id: Some("example.chat".into()),
            app_name: Some("Chat".into()),
        }
    }

    impl RetainedField for GrowingField {
        fn focused_identity(&mut self, _: Instant) -> Option<DeliveryFieldFingerprint> {
            Some(self.identity.clone())
        }
        fn copy_string(&mut self, attribute: &str, _: Instant) -> Option<String> {
            match attribute {
                "AXValue" => Some(self.text.clone()),
                "AXSelectedText" => voice_edit::byte_range(&self.text, self.selection)
                    .map(|bytes| self.text[bytes].to_owned()),
                _ => None,
            }
        }
        fn selected_range(&mut self, _: Instant) -> Option<inline_edit::TextRange> {
            Some(self.selection)
        }
        fn select(&mut self, range: inline_edit::TextRange, _: Instant) -> bool {
            let valid = voice_edit::byte_range(&self.text, range).is_some();
            if valid {
                self.selection = range;
            }
            valid
        }
        fn write_selected_text(&mut self, text: &str, _: Instant) -> bool {
            let bytes = voice_edit::byte_range(&self.text, self.selection).unwrap();
            self.text.replace_range(bytes, text);
            self.selection = inline_edit::TextRange {
                location: self.selection.location + text.encode_utf16().count(),
                length: 0,
            };
            let lines = self.text.matches('\n').count() as i64 + 1;
            self.identity.frame.as_mut().unwrap().height = 20 + 20 * lines;
            true
        }
    }

    #[test]
    fn a_field_that_resizes_after_a_write_keeps_verified_edits_history_and_undo() {
        use crate::dictation_parity::DictationCommandAction as Action;
        let start = composer(40);
        let caret = inline_edit::TextRange {
            location: 11,
            length: 0,
        };
        let mut edit = AxOwnedDictationEdit {
            field: GrowingField {
                text: "Hello world".into(),
                selection: caret,
                identity: start.clone(),
            },
            fingerprint: start.clone(),
            policy: None,
            history: voice_edit::History::new(voice_edit::Image {
                text: "Hello world".into(),
                selection: caret,
            })
            .unwrap(),
            poisoned: false,
        };
        let deadline = || Instant::now() + Duration::from_secs(1);
        edit.apply_voice_action(&Action::InsertText("\n\n".into()), Some(&start), deadline())
            .unwrap();
        assert_eq!(edit.field.text, "Hello world\n\n");
        let grown = edit.field.identity.clone();
        assert_ne!(grown, start);
        assert_eq!(edit.fingerprint, grown);
        // Later captures fingerprint the grown field; either frame is the same field.
        for (action, expected) in [
            (Action::SelectPhrase("world".into()), &grown),
            (Action::UppercaseSelection, &start),
        ] {
            edit.apply_voice_action(&action, Some(expected), deadline())
                .unwrap();
        }
        assert_eq!(edit.field.text, "Hello WORLD\n\n");
        for _ in 0..3 {
            let current = edit.field.identity.clone();
            edit.apply_voice_action(&Action::UndoLastInsert, Some(&current), deadline())
                .unwrap();
        }
        assert_eq!(edit.field.text, "Hello world");
        assert_eq!(edit.field.identity.frame.unwrap().height, 40);
        assert!(!edit.poisoned);

        let mut sibling = composer(40);
        sibling.element_hash = Some(8);
        let mut other_role = composer(40);
        other_role.role = Some("AXTextField".into());
        let mut other_app = composer(40);
        other_app.app_bundle_id = Some("example.other".into());
        let mut other_pid = composer(40);
        other_pid.pid = Some(43);
        for other in [sibling, other_role, other_app, other_pid] {
            assert!(edit
                .apply_voice_action(&Action::MoveToEnd, Some(&other), deadline())
                .unwrap_err()
                .contains("field or app changed"));
            // Focus moved to the other field while the command was in flight.
            let retained = std::mem::replace(&mut edit.field.identity, other);
            assert!(edit
                .apply_voice_action(&Action::DeleteThat, Some(&retained), deadline())
                .unwrap_err()
                .contains("unavailable"));
            edit.field.identity = retained;
        }
        assert_eq!(edit.field.text, "Hello world");
    }

    #[test]
    fn commands_in_another_field_start_fresh_unless_they_need_our_earlier_edit() {
        use crate::dictation_parity::DictationCommandAction as Action;
        let retained = composer(40);
        let grown = composer(80);
        let mut other = composer(40);
        other.element_hash = Some(8);
        for action in [
            Action::UppercaseSelection,
            Action::ReplaceEntireSelection("text".into()),
            Action::DeleteSelection,
            Action::AppendToSelection("today".into()),
            Action::SelectPhrase("target".into()),
            Action::MoveToEnd,
            // A fresh session deletes a selection there, and with no selection
            // refuses because it holds no insertion of ours.
            Action::DeleteThat,
        ] {
            assert!(voice_edit_reuses_session(&retained, &grown, &action));
            assert!(!voice_edit_reuses_session(&retained, &other, &action));
        }
        for action in [Action::UndoLastInsert, Action::DeleteLastSentence] {
            assert!(voice_edit_reuses_session(&retained, &grown, &action));
            assert!(voice_edit_reuses_session(&retained, &other, &action));
        }
    }
}

#[cfg(test)]
mod field_name_tests {
    #[test]
    fn names_in_field_keeps_capitalized_words_once() {
        let names = super::names_in_field(
            "Hi Anjali, thanks. Anjali and Supabase look good; ask OpenAI or NASA. Thanks!",
        );
        assert!(names.contains(&"Anjali".to_string()) && names.contains(&"Supabase".to_string()));
        assert_eq!(names.iter().filter(|name| *name == "Anjali").count(), 1);
    }
}

#[cfg(target_os = "macos")]
fn serve_voice_edit(
    mut edit: AxOwnedDictationEdit,
    receiver: std::sync::mpsc::Receiver<UndoRequest>,
) {
    // One retained field, bounded text and history. Inactivity releases all private state.
    while let Ok(request) = receiver.recv_timeout(std::time::Duration::from_secs(45)) {
        let legacy_undo = request.action.is_none();
        let result = match request.action {
            Some(action) => {
                edit.apply_voice_action(&action, request.expected.as_ref(), request.deadline)
            }
            None => edit.reverse(request.expected.as_ref(), request.deadline),
        };
        let failed = result.is_err() && edit.poisoned;
        let _ = request.reply.send(result);
        if failed || legacy_undo {
            break;
        }
    }
}

#[cfg(target_os = "macos")]
fn send_voice_edit_request(
    sender: &std::sync::mpsc::SyncSender<UndoRequest>,
    request: UndoRequest,
    retained: bool,
) -> Result<Option<UndoRequest>, String> {
    match sender.try_send(request) {
        Ok(()) => Ok(None),
        Err(std::sync::mpsc::TrySendError::Disconnected(request))
            if retained
                && request
                    .action
                    .as_ref()
                    .is_some_and(voice_edit_starts_target) =>
        {
            // Disconnection proves this request was never dispatched. A fresh
            // actor gets one attempt; it cannot recursively restart itself.
            Ok(Some(request))
        }
        Err(_) => Err("The voice edit expired. Select the text again and retry.".into()),
    }
}

/// Executes only against the start-time fingerprint. No activation or keystrokes.
pub(crate) fn execute_native_voice_edit(
    edit: Option<OwnedDictationEdit>,
    action: crate::dictation_parity::DictationCommandAction,
    expected: Option<DeliveryFieldFingerprint>,
) -> Result<OwnedDictationEdit, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (edit, action, expected);
        Err("Safe voice editing is only supported on macOS.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let expected = expected
            .filter(DeliveryFieldFingerprint::usable)
            .ok_or("The original field could not be verified. Voice edit was refused.")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(750);
        let edit = edit.filter(|edit| voice_edit_reuses_session(&edit.field, &expected, &action));
        let retained = edit.is_some();
        let edit = if let Some(edit) = edit {
            edit
        } else {
            let (requests, receiver) = std::sync::mpsc::sync_channel(1);
            let (ready, initialized) = std::sync::mpsc::sync_channel(1);
            let field = expected.clone();
            std::thread::spawn(move || {
                let result = (|| {
                    if secure_event_input_enabled() {
                        return Err("Voice editing is unavailable in secure fields.".to_string());
                    }
                    let element = UndoAxObject(copy_frontmost_focused_accessibility_element(None, None)?
                        .ok_or("The focused field is unavailable. Check Accessibility permission for this app copy.")?);
                    if classify_focused_element_security(element.0).is_some() {
                        return Err("Voice editing is unavailable in secure fields.".into());
                    }
                    let mut retained = AxRetainedField(element);
                    let (text, selection) = inline_edit::Backend::read_state(
                        &mut UndoBackend {
                            field: &mut retained,
                            fingerprint: &field,
                        },
                        deadline,
                    )
                    .ok_or(
                        "The original field changed or could not be read. Voice edit was refused.",
                    )?;
                    let history = voice_edit::History::new(voice_edit::Image { text, selection })
                        .ok_or("The field is too long or has an invalid selection. Voice edit was refused.")?;
                    Ok(AxOwnedDictationEdit {
                        field: retained,
                        fingerprint: field,
                        policy: None,
                        history,
                        poisoned: false,
                    })
                })();
                match result {
                    Ok(edit) => {
                        if ready.send(Ok(())).is_ok() {
                            serve_voice_edit(edit, receiver);
                        }
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                    }
                }
            });
            initialized
                .recv_timeout(std::time::Duration::from_secs(2))
                .map_err(|_| "The focused field could not be verified.".to_string())??;
            OwnedDictationEdit {
                requests,
                field: expected.clone(),
            }
        };
        let (reply, result) = std::sync::mpsc::sync_channel(1);
        if let Some(request) = send_voice_edit_request(
            &edit.requests,
            UndoRequest {
                action: Some(action),
                expected: Some(expected),
                deadline,
                reply,
            },
            retained,
        )? {
            return execute_native_voice_edit(
                None,
                request.action.expect("fresh command"),
                request.expected,
            );
        }
        result
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| {
                "Voice edit could not be verified. Check the field before trying again.".to_string()
            })??;
        Ok(edit)
    }
}

#[cfg(target_os = "macos")]
impl<F: RetainedField> AxOwnedDictationEdit<F> {
    fn apply_voice_action(
        &mut self,
        action: &crate::dictation_parity::DictationCommandAction,
        expected: Option<&DeliveryFieldFingerprint>,
        deadline: std::time::Instant,
    ) -> Result<bool, String> {
        use inline_edit::Backend;
        if !expected.is_some_and(|field| field.usable() && field.same_field(&self.fingerprint)) {
            return Err("The focused field or app changed. Voice edit was refused.".into());
        }
        if std::time::Instant::now() >= deadline {
            return Err("Voice edit expired before it could run.".into());
        }
        let mut backend = UndoBackend {
            field: &mut self.field,
            fingerprint: &self.fingerprint,
        };
        let image = |backend: &mut UndoBackend<'_, F>| {
            backend
                .read_state(deadline)
                .map(|(text, selection)| voice_edit::Image { text, selection })
        };
        let before = image(&mut backend)
            .ok_or("The original field is unavailable or secure. Voice edit was refused.")?;
        let plan = self.history.plan(&before, action)?;
        self.poisoned = true;
        if !backend.set_range(plan.range, deadline) {
            return Err("The field refused the selection change.".into());
        }
        let selected = voice_edit::Image {
            text: before.text,
            selection: plan.range,
        };
        if plan.replacement.is_some() {
            let bytes = voice_edit::byte_range(&selected.text, selected.selection)
                .ok_or("The selection range is invalid.")?;
            if backend.read_selected_text(deadline).as_deref() != Some(&selected.text[bytes]) {
                return Err(
                    "The selected text could not be verified. Voice edit was refused.".into(),
                );
            }
        }
        if image(&mut backend).as_ref() != Some(&selected) {
            return Err("The field changed before the edit. Voice edit was refused.".into());
        }
        if let Some(replacement) = &plan.replacement {
            // Recheck focus and security after the final complete-state read.
            if !backend.valid(deadline) || !backend.field.write_selected_text(replacement, deadline)
            {
                return Err("The focused field changed. Voice edit was refused.".into());
            }
            let current = image(&mut backend)
                .ok_or("Voice edit was sent but could not be verified. Check the field.")?;
            if current.text != plan.after.text {
                return Err(
                    "Voice edit was sent but the text did not match. Check the field.".into(),
                );
            }
            if current.selection != plan.after.selection
                && !backend.set_range(plan.after.selection, deadline)
            {
                return Err(
                    "The text changed, but the cursor could not be restored. Check the field."
                        .into(),
                );
            }
        }
        if image(&mut backend).as_ref() != Some(&plan.after) {
            return Err("Voice edit could not be verified. Check the field.".into());
        }
        // The same field may have resized; later checks compare its new frame.
        let refreshed = backend.current_identity(deadline);
        self.policy = None;
        self.history.commit(plan);
        self.poisoned = false;
        if let Some(refreshed) = refreshed {
            self.fingerprint = refreshed;
        }
        Ok(true)
    }
}

/// A retained session serves only its own field. In another field, undo and
/// last-sentence deletion still go to it, because only it knows Plainsong's
/// earlier edit (and it refuses the changed field). Everything else starts
/// fresh where focus is now: "delete that" then deletes a selection there,
/// or refuses because the fresh session holds no insertion of ours.
#[cfg(target_os = "macos")]
fn voice_edit_reuses_session(
    retained: &DeliveryFieldFingerprint,
    expected: &DeliveryFieldFingerprint,
    action: &crate::dictation_parity::DictationCommandAction,
) -> bool {
    use crate::dictation_parity::DictationCommandAction as Action;
    retained.same_field(expected)
        || matches!(action, Action::UndoLastInsert | Action::DeleteLastSentence)
}

#[cfg(target_os = "macos")]
fn voice_edit_starts_target(action: &crate::dictation_parity::DictationCommandAction) -> bool {
    use crate::dictation_parity::DictationCommandAction as Action;
    matches!(
        action,
        Action::SelectPhrase(_) | Action::MoveToStart | Action::MoveToEnd | Action::InsertText(_)
    )
}

pub(crate) fn voice_edit_is_deterministic(
    action: &crate::dictation_parity::DictationCommandAction,
) -> bool {
    use crate::dictation_parity::DictationCommandAction as Action;
    cfg!(target_os = "macos")
        && !matches!(
            action,
            Action::RewriteShorter(_) | Action::RewriteProfessional(_) | Action::Bulletize(_)
        )
}

pub(crate) fn voice_edit_uses_native_field(
    action: &crate::dictation_parity::DictationCommandAction,
    context_source: &str,
    insertion_mode: &str,
) -> bool {
    use crate::dictation_parity::DictationCommandAction as Action;
    voice_edit_is_deterministic(action)
        && (matches!(
            action,
            Action::SelectPhrase(_)
                | Action::MoveToStart
                | Action::MoveToEnd
                | Action::DeleteLastSentence
                | Action::DeleteThat
                | Action::UndoLastInsert
        ) || (insertion_mode == "auto"
            && !matches!(context_source, "clipboard" | "application_context")))
}

#[cfg(all(test, target_os = "macos"))]
mod native_voice_edit_probe {
    use super::*;
    use crate::dictation_parity::DictationCommandAction as Action;

    #[test]
    #[ignore = "opens only a throwaway TextEdit document; records permission refusal without prompting"]
    fn textedit_voice_edit_commands() {
        let receipt = std::env::var("PLAINSONG_VOICE_EDIT_RECEIPT").expect("receipt path required");
        if !check_accessibility_permission() {
            std::fs::write(receipt, serde_json::to_vec_pretty(&serde_json::json!({
                "accessibilityTrusted": false, "status": "blocked", "reason": "Accessibility permission is not granted to this test binary. No settings changed and no editing attempted."
            })).unwrap()).unwrap();
            return;
        }
        let nonce = uuid::Uuid::new_v4();
        let marker = format!("VOICE_EDIT_START_{nonce}");
        let file = std::env::temp_dir().join(format!("plainsong-voice-edit-{nonce}.txt"));
        std::fs::write(&file, &marker).unwrap();
        assert!(std::process::Command::new("/usr/bin/open")
            .args(["-a", "TextEdit"])
            .arg(&file)
            .status()
            .unwrap()
            .success());
        let mut field = None;
        for _ in 0..30 {
            field = capture_focused_field_fingerprint_without_activation()
                .filter(|field| field.app_bundle_id.as_deref() == Some("com.apple.TextEdit"));
            if field.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let field = field.expect("TextEdit field must be focused");
        let read = || {
            let element = UndoAxObject(
                copy_frontmost_focused_accessibility_element(None, Some("com.apple.TextEdit"))
                    .unwrap()
                    .unwrap(),
            );
            assert!(delivery_fingerprint_from_element(element.0)
                .is_some_and(|current| current.same_field(&field)));
            ax_copy_string_attribute(element.0, "AXValue")
                .unwrap()
                .unwrap()
        };
        assert_eq!(read(), marker);
        let original = "One sentence. Last sentence!";
        let select_marker = format!("select {marker}");
        let mut edit = None;
        for (spoken, expected) in [
            (select_marker.as_str(), marker.as_str()),
            ("replace that with One sentence. Last sentence!", original),
            ("delete last sentence", "One sentence. "),
            ("undo that", original),
            ("select Last sentence", original),
            (
                "replace that with Revised sentence",
                "One sentence. Revised sentence!",
            ),
            ("undo that", original),
            ("capitalise that", "One sentence. Last sentence!"),
            ("undo that", original),
            ("delete that", "One sentence. !"),
            ("undo that", original),
            ("move to end", original),
            ("new paragraph", "One sentence. Last sentence!\n\n"),
            ("undo that", original),
            ("move to start", original),
            ("undo that", original),
        ] {
            let (_, action) = crate::dictation_parity::parse_dictation_command(
                &format!("command {spoken}"),
                "command",
            )
            .unwrap();
            edit = Some(execute_native_voice_edit(edit, action, Some(field.clone())).unwrap());
            assert_eq!(read(), expected);
        }
        let mut mismatch = field.clone();
        mismatch.element_hash = Some(0);
        // Undo stays with the retained session, which refuses another field.
        let mismatch_error =
            execute_native_voice_edit(edit.clone(), Action::UndoLastInsert, Some(mismatch.clone()))
                .unwrap_err();
        assert!(
            mismatch_error.contains("field or app changed"),
            "{mismatch_error}"
        );
        // Other commands start fresh, and the focused field is not the expected one.
        let mismatch_error =
            execute_native_voice_edit(edit.take(), Action::DeleteThat, Some(mismatch)).unwrap_err();
        assert!(
            mismatch_error.contains("original field changed"),
            "{mismatch_error}"
        );
        assert_eq!(read(), original);
        for phrase in ["sentence", "absent phrase"] {
            let error = execute_native_voice_edit(
                None,
                Action::SelectPhrase(phrase.into()),
                Some(field.clone()),
            )
            .unwrap_err();
            let expected = if phrase == "sentence" {
                "more than once"
            } else {
                "not found"
            };
            assert!(error.contains(expected), "{error}");
            assert_eq!(read(), original);
        }
        std::fs::write(receipt, serde_json::to_vec_pretty(&serde_json::json!({
            "accessibilityTrusted": true, "status": "passed", "target": "throwaway TextEdit document", "commands": "insert, delete last sentence, select phrase, replace selection, sentence case, delete that, move, new paragraph, undo", "readback": original, "mismatchRefused": true, "ambiguousAndAbsentRefused": true, "globalHotkeys": false
        })).unwrap()).unwrap();
        // Leave the owned document open for inspection. Never close other documents or quit TextEdit.
    }
}
