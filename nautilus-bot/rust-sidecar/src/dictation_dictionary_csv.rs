use crate::models::{CreateDictationDictionaryEntryRequest, DictationDictionaryEntry};

const FORMULA_GUARD_COLUMN: &str = "plainsong_formula_guard_v1";

pub fn export_dictionary_entries_csv(entries: &[DictationDictionaryEntry]) -> String {
    let mut lines = vec![format!(
        "spoken_form,replacement,app_scope,case_sensitive,enabled,category_scope,{}",
        FORMULA_GUARD_COLUMN
    )];

    for entry in entries {
        lines.push(
            [
                csv_escape(&guard_spreadsheet_formula(entry.spoken_form.as_str())),
                csv_escape(&guard_spreadsheet_formula(entry.replacement.as_str())),
                csv_escape(&guard_spreadsheet_formula(
                    entry.app_scope.as_deref().unwrap_or(""),
                )),
                entry.case_sensitive.to_string(),
                entry.enabled.to_string(),
                csv_escape(&guard_spreadsheet_formula(
                    entry.category_scope.as_deref().unwrap_or(""),
                )),
                "true".to_string(),
            ]
            .join(","),
        );
    }

    lines.join("\n")
}

/// Splits raw CSV text into logical records, honoring quoted fields that
/// span physical lines (an exported replacement may contain '\n'). Returns
/// `(1-based starting line number, record text)` pairs.
fn split_csv_records(input: &str) -> Vec<(usize, String)> {
    let mut records = Vec::new();
    let mut current = String::new();
    let mut record_start_line = 1usize;
    let mut current_line = 1usize;
    let mut in_quotes = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    current.push('"');
                    current.push(chars.next().expect("peeked escaped quote"));
                } else {
                    in_quotes = !in_quotes;
                    current.push('"');
                }
            }
            '\r' if !in_quotes && chars.peek() == Some(&'\n') => {}
            '\n' if !in_quotes => {
                records.push((record_start_line, std::mem::take(&mut current)));
                current_line += 1;
                record_start_line = current_line;
            }
            '\n' => {
                current.push('\n');
                current_line += 1;
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        records.push((record_start_line, current));
    }

    records
}

pub fn parse_dictionary_entries_csv(
    input: &str,
) -> Result<Vec<CreateDictationDictionaryEntryRequest>, Vec<String>> {
    let mut rows = Vec::new();
    let mut errors = Vec::new();
    let mut first_non_empty_line = true;
    let mut formula_guard_enabled = false;

    for (line_number, record) in split_csv_records(input) {
        let line = record.trim();
        if line.is_empty() {
            continue;
        }

        if first_non_empty_line && looks_like_header(line) {
            first_non_empty_line = false;
            formula_guard_enabled = header_uses_formula_guard(line);
            continue;
        }
        first_non_empty_line = false;

        match parse_dictionary_line(line, formula_guard_enabled) {
            Ok(Some(row)) => rows.push(row),
            Ok(None) => {}
            Err(error) => errors.push(format!("Line {}: {}", line_number, error)),
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
    formula_guard_enabled: bool,
) -> Result<Option<CreateDictationDictionaryEntryRequest>, String> {
    let mut columns = parse_csv_line(line)?;
    if formula_guard_enabled {
        for index in [0usize, 1, 2, 5] {
            if let Some(value) = columns.get_mut(index) {
                remove_spreadsheet_formula_guard(value);
            }
        }
    }
    if columns.iter().all(|value| value.trim().is_empty()) {
        return Ok(None);
    }

    if columns.len() < 2 {
        return Err("expected at least spoken_form and replacement columns".to_string());
    }

    let spoken_form = columns[0].trim();
    // Keep the replacement verbatim (quoted fields may carry intentional
    // whitespace or newlines); only reject it when it has no content.
    let replacement = columns[1].as_str();
    if spoken_form.is_empty() {
        return Err("spoken_form cannot be empty".to_string());
    }
    if replacement.trim().is_empty() {
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
    if let Some(scope) = category_scope.as_deref() {
        if crate::settings::dictation_app_category_from_key_strict(scope).is_none() {
            return Err(format!(
                "unknown category_scope '{}' (expected one of: other, messaging, email, notes, worklog, ai_chat, code_editor)",
                scope
            ));
        }
    }

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

fn header_uses_formula_guard(line: &str) -> bool {
    parse_csv_line(line)
        .is_ok_and(|columns| columns.iter().any(|value| value == FORMULA_GUARD_COLUMN))
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
    let mut field_was_quoted = false;

    fn finish_field(current: &mut String, field_was_quoted: &mut bool) -> String {
        // Quoted fields keep their content verbatim (intentional
        // leading/trailing whitespace included); unquoted fields are
        // trimmed as before.
        let value = if *field_was_quoted {
            std::mem::take(current)
        } else {
            current.trim().to_string()
        };
        current.clear();
        *field_was_quoted = false;
        value
    }

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
                    field_was_quoted = true;
                } else {
                    current.push(ch);
                }
            }
            ',' if !in_quotes => {
                values.push(finish_field(&mut current, &mut field_was_quoted));
            }
            _ => current.push(ch),
        }
    }

    if in_quotes {
        return Err("unterminated quoted field".to_string());
    }

    values.push(finish_field(&mut current, &mut field_was_quoted));
    Ok(values)
}

fn csv_escape(value: &str) -> String {
    let has_edge_whitespace = value.chars().next().is_some_and(char::is_whitespace)
        || value.chars().next_back().is_some_and(char::is_whitespace);
    if value.contains([',', '"', '\n', '\r']) || has_edge_whitespace {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn guard_spreadsheet_formula(value: &str) -> String {
    if has_spreadsheet_formula_prefix(value) {
        format!("'{}", value)
    } else {
        value.to_string()
    }
}

fn remove_spreadsheet_formula_guard(value: &mut String) {
    let Some(remainder) = value.strip_prefix('\'') else {
        return;
    };
    if has_spreadsheet_formula_prefix(remainder) {
        value.remove(0);
    }
}

fn has_spreadsheet_formula_prefix(value: &str) -> bool {
    value
        .chars()
        .find(|character| {
            !(character.is_whitespace() || character.is_control() || *character == '\'')
        })
        .is_some_and(|character| {
            matches!(character, '=' | '+' | '-' | '@' | '＝' | '＋' | '－' | '＠')
        })
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
    fn dictionary_csv_round_trips_multiline_replacements() {
        // Regression: the importer used to split quoted multi-line fields on
        // raw '\n', so the app's own export was rejected with
        // "unterminated quoted field".
        let entries = vec![DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: "sig".to_string(),
            replacement: "Best,\nJon".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }];

        let csv = export_dictionary_entries_csv(&entries);
        let rows = parse_dictionary_entries_csv(&csv).expect("multiline export should re-parse");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].spoken_form, "sig");
        assert_eq!(rows[0].replacement, "Best,\nJon");
    }

    #[test]
    fn dictionary_csv_preserves_quoted_whitespace_in_replacements() {
        let rows = parse_dictionary_entries_csv("dash,\" — \",,false,true")
            .expect("quoted whitespace should parse");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].replacement, " — ");

        // Export quotes space-padded values so they survive a round trip
        // through the parser (persistence may still normalize further).
        let csv = export_dictionary_entries_csv(&[DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: "dash".to_string(),
            replacement: " — ".to_string(),
            app_scope: None,
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }]);
        assert!(csv.contains("dash,\" — \""));
    }

    #[test]
    fn dictionary_csv_rejects_unknown_category_scope_values() {
        let errors = parse_dictionary_entries_csv(
            "spoken_form,replacement,app_scope,case_sensitive,enabled,category_scope\nbrb,be right back,,false,true,ai chat",
        )
        .expect_err("typo'd category_scope should be rejected");
        assert_eq!(errors.len(), 1);
        assert!(
            errors[0].contains("unknown category_scope 'ai chat'"),
            "unexpected error: {}",
            errors[0]
        );
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

    #[test]
    fn export_dictionary_csv_guards_spreadsheet_formulas() {
        let csv = export_dictionary_entries_csv(&[DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: "=HYPERLINK(\"https://example.invalid\")".to_string(),
            replacement: "\t+cmd|' /C calc'!A0".to_string(),
            app_scope: Some("＠SUM(A1:A2)".to_string()),
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }]);
        let records = split_csv_records(&csv);
        let columns = parse_csv_line(&records[1].1).expect("exported row should parse");

        assert_eq!(columns[0], "'=HYPERLINK(\"https://example.invalid\")");
        assert_eq!(columns[1], "'\t+cmd|' /C calc'!A0");
        assert_eq!(columns[2], "'＠SUM(A1:A2)");
        assert_eq!(columns[6], "true");
    }

    #[test]
    fn guarded_dictionary_csv_round_trips_formula_like_values() {
        let entries = vec![DictationDictionaryEntry {
            id: "entry".to_string(),
            spoken_form: "'=literal formula".to_string(),
            replacement: "  ＝SUM(A1:A2)".to_string(),
            app_scope: Some("-dangerous".to_string()),
            case_sensitive: false,
            enabled: true,
            category_scope: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }];

        let csv = export_dictionary_entries_csv(&entries);
        let rows = parse_dictionary_entries_csv(&csv).expect("guarded export should re-parse");

        assert_eq!(rows[0].spoken_form, entries[0].spoken_form);
        assert_eq!(rows[0].replacement, entries[0].replacement);
        assert_eq!(rows[0].app_scope, entries[0].app_scope);
    }

    #[test]
    fn legacy_dictionary_csv_preserves_leading_apostrophes() {
        let rows = parse_dictionary_entries_csv(
            "spoken_form,replacement,app_scope,case_sensitive,enabled\n'=literal,'+literal,,false,true",
        )
        .expect("legacy csv should parse");

        assert_eq!(rows[0].spoken_form, "'=literal");
        assert_eq!(rows[0].replacement, "'+literal");
    }
}
