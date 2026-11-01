//! Run the production deterministic dictation stages on declared text fixtures.
//! This utility does not capture audio, load a model, or insert text.
use plainsong_lib::dictation_pipeline::{apply_dictation_pipeline, DictationPipelineInput};
use plainsong_lib::text::format::{dictation_category_prompt_fragment, DictationAppCategory};
use serde_json::{json, Value};
use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut input)?;
    let fixtures: Vec<Value> = serde_json::from_str(&input)?;
    let mut outputs = Vec::new();
    for fixture in fixtures {
        let category = match fixture["appCategory"].as_str().unwrap_or("other") {
            "messaging" => DictationAppCategory::Messaging,
            "email" => DictationAppCategory::Email,
            "notes" | "document" => DictationAppCategory::Notes,
            "worklog" => DictationAppCategory::Worklog,
            "ai_chat" => DictationAppCategory::AiChat,
            "code_editor" => DictationAppCategory::CodeEditor,
            _ => DictationAppCategory::Other,
        };
        let rules: Vec<Value> =
            fixture["dictionary"]
                .as_array()
                .map(|rules| {
                    rules.iter().enumerate().map(|(i, rule)| json!({
                "id": format!("fixture-{i}"),
                "spokenForm": rule["spokenForm"], "replacement": rule["replacement"],
                "appScope": null, "categoryScope": null,
                "caseSensitive": false, "enabled": true,
                "createdAt": "2026-10-02T00:00:00Z", "updatedAt": "2026-10-02T00:00:00Z"
            })).collect()
                })
                .unwrap_or_default();
        let dictionary_entries = serde_json::from_value::<Vec<_>>(json!(rules))?;
        let result = apply_dictation_pipeline(DictationPipelineInput {
            spoken_language: fixture["language"].as_str(),
            text: fixture["spokenText"]
                .as_str()
                .ok_or("Fixture lacks spokenText")?,
            dictionary_entries: &dictionary_entries,
            snippets: &[],
            app_target: None,
            mode_preset: "voice",
            smart_formatting_enabled: true,
            clean_disfluencies: true,
            numbers_as_digits: true,
            recent_inserted_text: None,
            command_mode_enabled: false,
            destination_category: category,
            // The production default: destination-aware formatting on and a
            // multi-line field. A fixture can opt out to model a single-line
            // field or the setting turned off.
            structured_layout: fixture["structuredLayout"].as_bool().unwrap_or(true),
        });
        outputs.push(json!({"id": fixture["id"], "text": result.text,
            "stages": result.pipeline_stage_keys, "categoryInstruction": dictation_category_prompt_fragment(category)}));
    }
    println!("{}", serde_json::to_string(&outputs)?);
    Ok(())
}
