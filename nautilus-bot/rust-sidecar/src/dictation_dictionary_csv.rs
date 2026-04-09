use crate::models::{CreateDictationDictionaryEntryRequest, DictationDictionaryEntry};

pub fn export_dictionary_entries_csv(entries: &[DictationDictionaryEntry]) -> String {
    let mut lines = vec!["spoken_form,replacement,app_scope,case_sensitive,enabled".to_string()];

    for entry in entries {
        lines.push(
            [
                csv_escape(entry.spoken_form.as_str()),
                csv_escape(entry.replacement.as_str()),
                csv_escape(entry.app_scope.as_deref().unwrap_or("")),
                entry.case_sensitive.to_string(),
                entry.enabled.to_string(),
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

    Ok(Some(CreateDictationDictionaryEntryRequest {
        spoken_form: spoken_form.to_string(),
        replacement: replacement.to_string(),
        app_scope,
        case_sensitive,
        enabled,
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
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }]);

        assert!(csv.contains("\"open, ai\",OpenAI,Slack,false,true"));
    }
}
