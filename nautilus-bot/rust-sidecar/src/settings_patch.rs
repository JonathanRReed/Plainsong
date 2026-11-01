//! Explicit settings edits, applied to the canonical value while its lock is held.
use crate::settings::Settings;
use serde_json::Value;

pub(crate) enum SettingsUpdate {
    Replace(Box<Settings>),
    Patch(SettingsPatch),
}

pub(crate) struct SettingsPatch(Vec<Operation>);

struct Operation {
    path: Vec<String>,
    value: Option<Value>,
}

impl SettingsPatch {
    pub(crate) fn parse(value: Value) -> Result<Self, String> {
        if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > 1_048_576 {
            return Err("Settings patch is too large".into());
        }
        let operations = value.as_array().ok_or("patch must be an array")?;
        if operations.len() > 256 {
            return Err("Settings patch has too many operations".into());
        }
        let mut parsed = Vec::with_capacity(operations.len());
        for operation in operations {
            let object = operation.as_object().ok_or("Invalid patch operation")?;
            let op = object
                .get("op")
                .and_then(Value::as_str)
                .ok_or("Missing patch op")?;
            let expected = match op {
                "set" => 3,
                "remove" => 2,
                _ => return Err("Unknown patch op".into()),
            };
            if object.len() != expected
                || object
                    .keys()
                    .any(|key| !matches!(key.as_str(), "op" | "path" | "value"))
                || (op == "remove" && object.contains_key("value"))
            {
                return Err("Invalid patch operation fields".into());
            }
            let path = object
                .get("path")
                .and_then(Value::as_array)
                .ok_or("path must be an array")?;
            if path.is_empty() || path.len() > 32 {
                return Err("Invalid patch path length".into());
            }
            let path = path
                .iter()
                .map(|part| {
                    part.as_str()
                        .filter(|part| {
                            !part.is_empty() && part.len() <= 256 && !part.contains('\0')
                        })
                        .map(str::to_owned)
                        .ok_or_else(|| "Invalid patch path component".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let value = if op == "set" {
                Some(object.get("value").ok_or("Missing patch value")?.clone())
            } else {
                None
            };
            parsed.push(Operation { path, value });
        }
        Ok(Self(parsed))
    }

    pub(crate) fn apply(self, current: &Settings) -> Result<Settings, String> {
        let mut raw = serde_json::to_value(current).map_err(|e| e.to_string())?;
        'operations: for operation in self.0 {
            let (key, parents) = operation.path.split_last().ok_or("Empty patch path")?;
            let mut parent = &mut raw;
            for part in parents {
                let object = parent
                    .as_object_mut()
                    .ok_or("Patch parent must be an object")?;
                if !object.contains_key(part) && operation.value.is_none() {
                    // Retrying a removal after its acknowledgment was lost is safe.
                    // An absent unknown key introduces no settings data.
                    continue 'operations;
                }
                parent = object
                    .get_mut(part)
                    .ok_or("Patch parent must be an existing object")?;
            }
            let object = parent
                .as_object_mut()
                .ok_or("Patch parent must be an object")?;
            match operation.value {
                Some(value) => {
                    object.insert(key.clone(), value);
                }
                None => {
                    object.remove(key);
                }
            }
        }
        let candidate: Settings = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
        let typed = serde_json::to_value(&candidate).map_err(|e| e.to_string())?;
        reject_unknown_keys(&raw, &typed)?;
        Ok(candidate)
    }
}

fn reject_unknown_keys(raw: &Value, typed: &Value) -> Result<(), String> {
    match (raw, typed) {
        (Value::Object(raw), Value::Object(typed)) => {
            for (key, value) in raw {
                reject_unknown_keys(
                    value,
                    typed
                        .get(key)
                        .ok_or_else(|| format!("Unknown settings key: {key}"))?,
                )?;
            }
        }
        (Value::Array(raw), Value::Array(typed)) => {
            for (raw, typed) in raw.iter().zip(typed) {
                reject_unknown_keys(raw, typed)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn apply(current: &Settings, value: Value) -> Result<Settings, String> {
        SettingsPatch::parse(value)?.apply(current)
    }

    #[test]
    fn explicit_settings_patches_preserve_unrelated_edits_in_both_orders() {
        let edits = [
            json!([{"op":"set","path":["transcription","dictationKeepAudio"],"value":false}]),
            json!([{"op":"set","path":["theme"],"value":"dark"}, {"op":"set","path":["transcription","dictationRetentionCustomHours"],"value":17}]),
        ];
        for order in [[0, 1], [1, 0]] {
            let mut current = Settings::default();
            current.transcription.dictation_keep_audio = true;
            let original_audio = serde_json::to_value(&current.audio).unwrap();
            for index in order {
                current = apply(&current, edits[index].clone()).unwrap();
            }
            assert!(!current.transcription.dictation_keep_audio);
            assert_eq!(current.theme, "dark");
            assert_eq!(current.transcription.dictation_retention_custom_hours, 17);
            assert_eq!(serde_json::to_value(current.audio).unwrap(), original_audio);
        }
    }

    #[test]
    fn explicit_settings_patch_supports_null_map_removal_and_atomic_arrays() {
        let mut current = Settings::default();
        current.transcription.language = Some("en".into());
        current
            .transcription
            .provider_model_ids
            .insert("old".into(), "old-model".into());
        let candidate = apply(&current, json!([
            {"op":"set","path":["transcription","language"],"value":null},
            {"op":"remove","path":["transcription","providerModelIds","old"]},
            {"op":"set","path":["transcription","dictationActiveLanguages"],"value":["fr", "de"]},
            {"op":"set","path":["theme"],"value":"light"},
            {"op":"set","path":["theme"],"value":"dark"}
        ])).unwrap();
        assert!(candidate.transcription.language.is_none());
        assert!(!candidate
            .transcription
            .provider_model_ids
            .contains_key("old"));
        assert_eq!(
            candidate.transcription.dictation_active_languages,
            vec!["fr", "de"]
        );
        assert_eq!(candidate.theme, "dark");
    }

    #[test]
    fn explicit_settings_patch_rejects_malformed_operations() {
        for value in [
            json!(null),
            json!({}),
            json!([{}]),
            json!([{"op":"merge","path":["theme"],"value":"dark"}]),
            json!([{"op":"set","path":["theme"]}]),
            json!([{"op":"remove","path":["theme"],"value":null}]),
            json!([{"op":"set","path":[],"value":null}]),
            json!([{"op":"set","path":[0],"value":null}]),
            json!([{"op":"set","path":[""],"value":null}]),
            json!([{"op":"set","path":["theme"],"value":"dark","extra":true}]),
        ] {
            assert!(SettingsPatch::parse(value).is_err());
        }
        assert!(SettingsPatch::parse(Value::Array(vec![
            json!({"op":"set","path":["theme"],"value":"dark"});
            257
        ]))
        .is_err());
        assert!(SettingsPatch::parse(
            json!([{"op":"set","path":["theme"],"value":"x".repeat(1_048_576)}])
        )
        .is_err());
    }

    #[test]
    fn explicit_settings_patch_failure_never_mutates_current_settings() {
        let current = Settings::default();
        let before = serde_json::to_value(&current).unwrap();
        for operation in [
            json!({"op":"set","path":["unknown"],"value":true}),
            json!({"op":"set","path":["audio"],"value":{"unknown":true}}),
            json!({"op":"set","path":["theme"],"value":false}),
            json!({"op":"set","path":["transcription","dictationActiveLanguages","0"],"value":"fr"}),
            json!({"op":"set","path":["audio","preferredInputDevice"],"value":{"unknown":true}}),
        ] {
            assert!(apply(
                &current,
                json!([{"op":"set","path":["theme"],"value":"dark"},operation])
            )
            .is_err());
            assert_eq!(serde_json::to_value(&current).unwrap(), before);
        }
    }

    #[test]
    fn explicit_settings_patch_removal_is_idempotent_but_rejects_non_object_parents() {
        let mut current = Settings::default();
        current
            .transcription
            .provider_model_ids
            .insert("old".into(), "model".into());
        let patch = json!([{"op":"remove","path":["transcription","providerModelIds","old"]},
            {"op":"remove","path":["absent","child"]}]);
        let once = apply(&current, patch.clone()).unwrap();
        let twice = apply(&once, patch).unwrap();
        assert_eq!(
            serde_json::to_value(once).unwrap(),
            serde_json::to_value(twice).unwrap()
        );
        assert!(apply(&current, json!([{"op":"remove","path":["theme","child"]}])).is_err());
    }

    #[test]
    fn explicit_settings_patch_preserves_unedited_sidecar_owned_fields() {
        let mut current = Settings::default();
        current.onboarding.completed_at = Some("2026-10-17".into());
        let before = serde_json::to_value(&current).unwrap();
        let candidate = apply(
            &current,
            json!([{"op":"set","path":["theme"],"value":"dark"}]),
        )
        .unwrap();
        let after = serde_json::to_value(candidate).unwrap();
        for key in ["privacy", "onboarding", "ai"] {
            assert_eq!(before[key], after[key]);
        }
    }
}
