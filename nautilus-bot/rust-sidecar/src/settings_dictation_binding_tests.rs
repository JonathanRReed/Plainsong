//! Tests for the dictation binding table (roadmap item B4): the migration
//! from the legacy `toggleDictation` key, the tolerant load, the validator,
//! and the save-path reconciliation with writers that only know the old key.
//! Also covers the tolerant load of B7a's `translateToEnglish` flags, which
//! arrive in the same settings file.

use super::{
    reconcile_saved_keyboard_shortcuts, validate_dictation_bindings, DictationBinding,
    DictationBindingAction, DictationBindingTrigger, KeyboardShortcuts, Settings, SettingsManager,
    PRIMARY_DICTATION_BINDING_ID,
};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_settings_file(tag: &str, raw: &serde_json::Value) -> (PathBuf, PathBuf) {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("nautilus-settings-{tag}-{suffix}"));
    let settings_path = root.join("settings.json");
    fs::create_dir_all(&root).expect("create settings test directory");
    fs::write(
        &settings_path,
        serde_json::to_string(raw).expect("serialize"),
    )
    .expect("write settings");
    (root, settings_path)
}

fn key_binding(id: &str, accelerator: &str, mode_id: Option<&str>) -> DictationBinding {
    DictationBinding {
        id: id.to_string(),
        trigger: DictationBindingTrigger::Key {
            accelerator: accelerator.to_string(),
        },
        action: DictationBindingAction::Dictation {
            mode_id: mode_id.map(str::to_string),
            behavior: "inherit".to_string(),
        },
    }
}

#[test]
fn settings_file_without_bindings_migrates_the_legacy_hotkey_into_one_binding() {
    let legacy = serde_json::json!({
        "shortcuts": {
            "toggleDictation": "Ctrl+Alt+D",
            "openWindow": "Ctrl+Shift+N"
        }
    });
    let (root, settings_path) = temp_settings_file("bindings-migrate", &legacy);

    let manager = SettingsManager::load_from_path(settings_path).expect("load legacy settings");
    let shortcuts = &manager.settings().shortcuts;
    assert_eq!(shortcuts.toggle_dictation, "Ctrl+Alt+D");
    assert_eq!(
        shortcuts.dictation_bindings,
        vec![key_binding(
            PRIMARY_DICTATION_BINDING_ID,
            "Ctrl+Alt+D",
            None
        )]
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn bindings_are_the_source_of_truth_for_the_legacy_key_on_load() {
    let raw = serde_json::json!({
        "shortcuts": {
            "toggleDictation": "Cmd+Shift+Space",
            "dictationBindings": [
                { "id": "email", "trigger": { "kind": "key", "accelerator": "Cmd+Alt+E" },
                  "action": { "kind": "dictation", "modeId": "email", "behavior": "toggle" } },
                { "id": "primary", "trigger": { "kind": "key", "accelerator": "Ctrl+Alt+D" },
                  "action": { "kind": "dictation", "modeId": null, "behavior": "inherit" } },
                { "id": "cycle", "trigger": { "kind": "mouse", "button": 4 },
                  "action": { "kind": "cycleMode" } }
            ]
        }
    });
    let (root, settings_path) = temp_settings_file("bindings-truth", &raw);

    let manager = SettingsManager::load_from_path(settings_path).expect("load settings");
    let shortcuts = &manager.settings().shortcuts;
    assert_eq!(shortcuts.toggle_dictation, "Ctrl+Alt+D");
    assert_eq!(shortcuts.dictation_bindings.len(), 3);
    assert_eq!(
        shortcuts.dictation_bindings[2].action,
        DictationBindingAction::CycleMode
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_unreadable_binding_is_dropped_without_losing_the_rest() {
    let raw = serde_json::json!({
        "shortcuts": {
            "toggleDictation": "Cmd+Shift+Space",
            "dictationBindings": [
                { "id": "primary", "trigger": { "kind": "key", "accelerator": "Cmd+Shift+Space" },
                  "action": { "kind": "dictation" } },
                { "id": "broken", "trigger": { "kind": "touchbar" }, "action": { "kind": "dictation" } },
                "not even an object"
            ]
        }
    });
    let (root, settings_path) = temp_settings_file("bindings-tolerant", &raw);

    let manager = SettingsManager::load_from_path(settings_path).expect("load settings");
    let bindings = &manager.settings().shortcuts.dictation_bindings;
    assert_eq!(bindings.len(), 1);
    assert_eq!(bindings[0].id, "primary");
    assert_eq!(
        bindings[0].action,
        DictationBindingAction::Dictation {
            mode_id: None,
            behavior: "inherit".to_string()
        }
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn default_settings_carry_the_primary_binding_and_serialize_the_legacy_key_too() {
    let json = serde_json::to_value(Settings::default()).expect("serialize");
    let shortcuts = &json["shortcuts"];
    assert!(shortcuts["toggleDictation"].as_str().is_some());
    assert_eq!(
        shortcuts["dictationBindings"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(shortcuts["dictationBindings"][0]["trigger"]["kind"], "key");
    assert_eq!(
        shortcuts["dictationBindings"][0]["trigger"]["accelerator"],
        shortcuts["toggleDictation"]
    );
    assert_eq!(
        shortcuts["dictationBindings"][0]["action"]["kind"],
        "dictation"
    );
    assert_eq!(
        shortcuts["dictationBindings"][0]["action"]["behavior"],
        "inherit"
    );
}

/// A settings file written before B4/B7a has neither the binding table nor
/// any `translateToEnglish` key. It must load with its own hotkey intact, its
/// saved profiles intact, and translation off everywhere -- the flag is opt-in
/// and nothing may turn it on for an existing install.
#[test]
fn a_settings_file_written_before_b4_and_b7a_loads_with_translation_off() {
    let legacy = serde_json::json!({
        "shortcuts": { "toggleDictation": "Ctrl+Alt+D" },
        "transcription": {
            "defaultProvider": "whisper",
            "selectedModelId": "base",
            "dictationCustomModes": [
                { "id": "sales", "name": "Sales Follow-up", "profile": "normal_speed" }
            ]
        }
    });
    let (root, settings_path) = temp_settings_file("pre-b7a", &legacy);

    let manager = SettingsManager::load_from_path(settings_path).expect("load legacy settings");
    let settings = manager.settings();
    assert_eq!(settings.shortcuts.toggle_dictation, "Ctrl+Alt+D");
    assert_eq!(
        settings.shortcuts.dictation_bindings,
        vec![key_binding(
            PRIMARY_DICTATION_BINDING_ID,
            "Ctrl+Alt+D",
            None
        )]
    );
    assert!(!settings.transcription.dictation_translate_to_english);
    let modes = &settings.transcription.dictation_custom_modes;
    assert_eq!(modes.len(), 1, "the saved profile must survive the load");
    assert!(!modes[0].translate_to_english);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn validator_rejects_duplicate_triggers_and_bare_letters() {
    let duplicate = vec![
        key_binding("a", "Cmd+Shift+Space", None),
        key_binding("b", "shift cmd space", Some("email")),
    ];
    let error = validate_dictation_bindings(&duplicate).expect_err("duplicate trigger");
    assert!(error.contains("same trigger"), "{error}");

    let bare = vec![key_binding("a", "D", None)];
    let error = validate_dictation_bindings(&bare).expect_err("bare letter");
    assert!(error.contains("ordinary typing"), "{error}");

    let bare_space = vec![key_binding("a", "Space", None)];
    assert!(validate_dictation_bindings(&bare_space).is_err());

    let function_key = vec![key_binding("a", "F5", None)];
    validate_dictation_bindings(&function_key).expect("a function key alone is fine");

    let lone_modifier = vec![key_binding("a", "Fn", None)];
    validate_dictation_bindings(&lone_modifier).expect("a lone modifier is an explicit choice");

    let bad_button = vec![DictationBinding {
        id: "m".to_string(),
        trigger: DictationBindingTrigger::Mouse {
            button: 1,
            modifiers: Vec::new(),
        },
        action: DictationBindingAction::Cancel,
    }];
    assert!(validate_dictation_bindings(&bad_button).is_err());

    let duplicate_ids = vec![
        key_binding("same", "Cmd+Alt+1", None),
        key_binding("same", "Cmd+Alt+2", None),
    ];
    assert!(validate_dictation_bindings(&duplicate_ids).is_err());

    let fine = vec![
        key_binding("primary", "Cmd+Shift+Space", None),
        key_binding("email", "Cmd+Alt+E", Some("email")),
        DictationBinding {
            id: "cycle".to_string(),
            trigger: DictationBindingTrigger::Mouse {
                button: 4,
                modifiers: vec!["Cmd".to_string()],
            },
            action: DictationBindingAction::CycleMode,
        },
    ];
    validate_dictation_bindings(&fine).expect("a distinct table validates");
}

#[test]
fn a_save_that_only_edits_the_legacy_key_moves_the_primary_binding() {
    let previous = KeyboardShortcuts::default();
    let mut incoming = previous.clone();
    incoming.toggle_dictation = "Ctrl+Alt+D".to_string();
    reconcile_saved_keyboard_shortcuts(&mut incoming, &previous);
    assert_eq!(incoming.toggle_dictation, "Ctrl+Alt+D");
    assert_eq!(
        incoming.dictation_bindings,
        vec![key_binding(
            PRIMARY_DICTATION_BINDING_ID,
            "Ctrl+Alt+D",
            None
        )]
    );

    // Clearing the legacy key alone switches the hotkey off instead of
    // snapping back to the default.
    let mut cleared = previous.clone();
    cleared.toggle_dictation = String::new();
    reconcile_saved_keyboard_shortcuts(&mut cleared, &previous);
    assert!(cleared.dictation_bindings.is_empty());
    assert_eq!(cleared.toggle_dictation, "");

    // When the table itself changed, it wins over a stale legacy key.
    let mut retabled = previous.clone();
    retabled.toggle_dictation = "Ctrl+Alt+D".to_string();
    retabled.dictation_bindings = vec![key_binding("primary", "Cmd+Alt+Space", None)];
    reconcile_saved_keyboard_shortcuts(&mut retabled, &previous);
    assert_eq!(retabled.toggle_dictation, "Cmd+Alt+Space");
}
