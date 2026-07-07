use crate::models::{CreateDictationDictionaryEntryRequest, DictationDictionaryEntry};

pub fn export_dictionary_entries_csv(entries: &[DictationDictionaryEntry]) -> String {
    let mut lines =
        vec!["spoken_form,replacement,app_scope,case_sensitive,enabled,category_scope".to_string()];

    for entry in entries {
        lines.push(
            [
                csv_escape(entry.spoken_form.as_str()),
                csv_escape(entry.replacement.as_str()),
                csv_escape(entry.app_scope.as_deref().unwrap_or("")),
                entry.case_sensitive.to_string(),
                entry.enabled.to_string(),
                csv_escape(entry.category_scope.as_deref().unwrap_or("")),
            ]
            .join(","),
        );
    }

    lines.join("\n")
}

pub fn parse_dictionary_entries_csv(
    input: &str,
) -> Result<Vec<CreateDictationDictionaryEntryRequest>, Vec<String>> {
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let mut first_non_empty_line = true;

    for (line_index, raw_line) in input.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if first_non_empty_line && looks_like_header(line) {
            first_non_empty_line = false;
            continue;
        }
        first_non_empty_line = false;

        match parse_dictionary_line(line) {
            Ok(Some(row)) => rows.push(row),
            Ok(None) => {}
            Err(error) => errors.push(format!("Line {}: {}", line_index + 1, error)),
        }
    }

    if !errors.is_empty() {
        Err(errors)
    } else {
        Ok(rows)
    }
}

fn parse_dictionary_line(
    line: &str,
) -> Result<Option<CreateDictationDictionaryEntryRequest>, String> {
    let columns = parse_csv_line(line)?;
    if columns.iter().all(|value| value.trim().is_empty()) {
        return Ok(None);
    }

    if columns.len() < 2 {
        return Err("expected at least spoken_form and replacement columns".to_string());
    }

    let spoken_form = columns[0].trim();
    let replacement = columns[1].trim();
    if spoken_form.is_empty() {
        return Err("spoken_form cannot be empty".to_string());
    }
    if replacement.is_empty() {
        return Err("replacement cannot be empty".to_string());
    }

    let app_scope = columns
        .get(2)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let case_sensitive = columns
        .get(3)
        .map(|value| parse_bool(value.as_str()))
        .transpose()?
        .unwrap_or(false);
    let enabled = columns
        .get(4)
        .map(|value| parse_bool(value.as_str()))
        .transpose()?
        .unwrap_or(true);
    let category_scope = columns
        .get(5)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Ok(Some(CreateDictationDictionaryEntryRequest {
        spoken_form: spoken_form.to_string(),
        replacement: replacement.to_string(),
        app_scope,
        case_sensitive,
        enabled,
        category_scope,
    }))
}

fn looks_like_header(line: &str) -> bool {
    let lowercase = line.to_lowercase();
    lowercase.contains("spoken_form") || lowercase.contains("spoken form")
}

fn parse_bool(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" => Ok(false),
        "1" | "true" | "yes" | "y" | "on" => Ok(true),
        "0" | "false" | "no" | "n" | "off" => Ok(false),
        other => Err(format!("invalid boolean '{}'", other)),
    }
}

fn parse_csv_line(line: &str) -> Result<Vec<String>, String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            }
            '"' => {
                if current.trim().is_empty() {
                    current.clear();
                    in_quotes = true;
                } else {
                    current.push(ch);
                }
            }
            ',' if !in_quotes => {
                values.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }

    if in_quotes {
        return Err("unterminated quoted field".to_string());
    }

    values.push(current.trim().to_string());
    Ok(values)
}

fn csv_escape(value: &str) -> String {
    if value.contains([',', '"', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn parse_dictionary_csv_supports_header_and_quotes() {
        let rows = parse_dictionary_entries_csv(
            "spoken_form,replacement,app_scope,case_sensitive,enabled\n\"open, ai\",OpenAI,,false,true",
        )
        .expect("csv should parse");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].spoken_form, "open, ai");
        assert_eq!(rows[0].replacement, "OpenAI");
        assert!(!rows[0].case_sensitive);
        assert!(rows[0].enabled);
        // Legacy 5-column rows (no category_scope column at all) must still
        // parse cleanly, with category_scope defaulting to None.
        assert!(rows[0].category_scope.is_none());
    }

    #[test]
    fn export_dictionary_csv_escapes_commas() {
        let csv = export_dictionary_entries_csv(&[DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: "open, ai".to_string(),
            replacement: "OpenAI".to_string(),
            app_scope: Some("Slack".to_string()),
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }]);

        assert!(csv.contains("\"open, ai\",OpenAI,Slack,false,true,"));
    }

    #[test]
    fn export_dictionary_csv_includes_category_scope_column() {
        let csv = export_dictionary_entries_csv(&[DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: "brb".to_string(),
            replacement: "be right back".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: Some("messaging".to_string()),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }]);

        assert!(csv.starts_with(
            "spoken_form,replacement,app_scope,case_sensitive,enabled,category_scope"
        ));
        assert!(csv.contains("brb,be right back,,false,true,messaging"));
    }

    #[test]
    fn parse_dictionary_csv_round_trips_category_scope_when_present() {
        let rows = parse_dictionary_entries_csv(
            "spoken_form,replacement,app_scope,case_sensitive,enabled,category_scope\nbrb,be right back,Slack,false,true,messaging",
        )
        .expect("csv should parse");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].spoken_form, "brb");
        assert_eq!(rows[0].category_scope.as_deref(), Some("messaging"));
    }

    #[test]
    fn parse_dictionary_csv_round_trips_without_category_scope_value() {
        let rows = parse_dictionary_entries_csv(
            "spoken_form,replacement,app_scope,case_sensitive,enabled,category_scope\nopen ai,OpenAI,,false,true,",
        )
        .expect("csv should parse");

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].spoken_form, "open ai");
        assert!(rows[0].category_scope.is_none());
    }

    #[test]
    fn export_then_parse_dictionary_csv_round_trips_category_scope() {
        let entries = vec![
            DictationDictionaryEntry {
                id: "entry-1".to_string(),
                spoken_form: "brb".to_string(),
                replacement: "be right back".to_string(),
                app_scope: None,
                case_sensitive: false,
                enabled: true,
                category_scope: Some("messaging".to_string()),
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
            DictationDictionaryEntry {
                id: "entry-2".to_string(),
                spoken_form: "open ai".to_string(),
                replacement: "OpenAI".to_string(),
                app_scope: Some("Slack".to_string()),
                case_sensitive: false,
                enabled: true,
                category_scope: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            },
        ];

        let csv = export_dictionary_entries_csv(&entries);
        let rows = parse_dictionary_entries_csv(&csv).expect("exported csv should re-parse");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].spoken_form, "brb");
        assert_eq!(rows[0].category_scope.as_deref(), Some("messaging"));
        assert_eq!(rows[1].spoken_form, "open ai");
        assert!(rows[1].category_scope.is_none());
    }
}
