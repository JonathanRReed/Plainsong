use crate::dictation_correction_capture::FocusedFieldFrame;
use crate::models::DictationStartOptions;
use crate::text_insert::{
    validate_delivery_field_identity, DeliveryFieldFingerprint, DICTATION_FOCUS_CHANGED_MESSAGE,
};

fn fingerprint() -> DeliveryFieldFingerprint {
    DeliveryFieldFingerprint {
        pid: Some(42),
        element_hash: Some(0x1234),
        role: Some("AXTextArea".to_string()),
        identifier: Some("message-editor".to_string()),
        frame: Some(FocusedFieldFrame {
            x: 10,
            y: 20,
            width: 300,
            height: 120,
        }),
        app_bundle_id: Some("com.example.Editor".to_string()),
        app_name: Some("Editor".to_string()),
    }
}

#[test]
fn same_delivery_field_identity_is_accepted() {
    let expected = fingerprint();
    assert_eq!(
        validate_delivery_field_identity(Some(&expected), Some(&expected.clone())),
        Ok(())
    );
}

#[test]
fn changed_element_pid_or_identifier_is_rejected() {
    let expected = fingerprint();
    for current in [
        DeliveryFieldFingerprint {
            element_hash: Some(0x9999),
            ..expected.clone()
        },
        DeliveryFieldFingerprint {
            pid: Some(77),
            ..expected.clone()
        },
        DeliveryFieldFingerprint {
            identifier: Some("search-field".to_string()),
            ..expected.clone()
        },
    ] {
        assert_eq!(
            validate_delivery_field_identity(Some(&expected), Some(&current)),
            Err(DICTATION_FOCUS_CHANGED_MESSAGE.to_string())
        );
    }
}

#[test]
fn known_expected_field_rejects_unknown_current_field() {
    let expected = fingerprint();
    assert_eq!(
        validate_delivery_field_identity(Some(&expected), None),
        Err(DICTATION_FOCUS_CHANGED_MESSAGE.to_string())
    );
    assert_eq!(
        validate_delivery_field_identity(
            Some(&expected),
            Some(&DeliveryFieldFingerprint::default())
        ),
        Err(DICTATION_FOCUS_CHANGED_MESSAGE.to_string())
    );
}

#[test]
fn absent_expected_field_retains_legacy_app_level_behavior() {
    assert_eq!(
        validate_delivery_field_identity(None, Some(&fingerprint())),
        Ok(())
    );
    assert_eq!(validate_delivery_field_identity(None, None), Ok(()));
}

#[test]
fn fingerprint_debug_output_is_redacted() {
    let debug = format!("{:?}", fingerprint());
    assert_eq!(debug, "DeliveryFieldFingerprint([redacted])");
    assert!(!debug.contains("message-editor"));
    assert!(!debug.contains("com.example.Editor"));
    assert!(!debug.contains("42"));
}

#[test]
fn dictation_start_options_neither_emit_nor_accept_a_fingerprint() {
    let options = DictationStartOptions {
        focused_field_fingerprint: Some(fingerprint()),
        ..Default::default()
    };
    let serialized = serde_json::to_value(&options).expect("serialize dictation options");
    assert!(serialized.get("focusedFieldFingerprint").is_none());
    assert!(!serialized.to_string().contains("message-editor"));

    let decoded: DictationStartOptions = serde_json::from_value(serde_json::json!({
        "saveToInbox": true,
        "focusedFieldFingerprint": {
            "pid": 999,
            "elementHash": 888,
            "identifier": "attacker-supplied"
        }
    }))
    .expect("deserialize dictation options");
    assert!(decoded.focused_field_fingerprint.is_none());
}
