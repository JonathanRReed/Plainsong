//! Privacy-safe support bundle.
//!
//! `scripts/capture-support-bundle.mjs` has always been able to write one of
//! these from a source checkout; an installed beta could not, so the only
//! diagnostics a tester could send were screenshots and prose
//! (`docs/beta/KNOWN-LIMITATIONS.md`). This module is the in-app version of
//! that script's job: it assembles the same *kind* of evidence — versions,
//! booleans, counts, enum-like identifiers — and refuses to carry content.
//!
//! Everything here except [`write_bundle`] is a pure function over
//! `serde_json::Value`, so the redaction policy is testable without a Mac, a
//! microphone, or a model on disk. The one impure function only zips bytes
//! that these functions already produced.
//!
//! ## The policy, in one place
//!
//! * A string under a key that looks like a credential is dropped outright.
//! * A string that is not identifier-shaped is dropped, because anything with
//!   spaces or slashes in it could be a sentence somebody dictated or a path
//!   with their name in it.
//! * A list is replaced by its length. Prompts, dictionary entries, snippets,
//!   and vocabulary hints all live in lists, and all of them are things the
//!   reader typed.
//! * Booleans and numbers pass through, because they cannot carry a sentence.
//!
//! That ordering matters: the default for an unrecognised string is to drop
//! it, so a settings field added next month is redacted until somebody
//! deliberately teaches this module that it is safe.

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Map, Value};
use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;

/// Bumped when the file set or the redaction policy changes in a way a reader
/// of an old bundle would need to know about.
pub const SCHEMA_VERSION: u32 = 2;

/// How many log lines the bundle will carry at most.
pub const MAX_LOG_LINES: usize = 400;

/// How many audit-log entries the bundle will carry at most.
pub const MAX_AUDIT_ENTRIES: usize = 200;

/// Longest a single redacted log line may be before it is truncated.
const MAX_LOG_LINE_CHARS: usize = 400;

/// Longest an app-authored diagnostic note may be before it is truncated.
const MAX_NOTE_CHARS: usize = 240;

/// Placeholder for a value that was dropped rather than rewritten.
pub const REDACTED: &str = "[redacted]";

/// Substrings that make a settings key a credential key whatever its value
/// looks like. Compared against the lowercased key.
const SECRET_KEY_MARKERS: &[&str] = &[
    "apikey",
    "api_key",
    "secret",
    "token",
    "password",
    "passphrase",
    "credential",
    "cookie",
];

/// Audit-detail fields whose values are app-generated machine identifiers.
///
/// Audit details have a narrower policy than settings: whether a value happens
/// to look identifier-like says nothing about whether it is reader-authored
/// content. New audit fields therefore remain redacted until they are reviewed
/// and explicitly added here.
const AUDIT_IDENTIFIER_FIELDS: &[&str] = &[
    "recording_id",
    "session_id",
    "template_id",
    "model",
    "format",
    "source",
    "engine",
    "backend",
    "strategy",
];

/// Audit-detail fields that contain only app-computed counts, sizes, durations,
/// or status switches.
const AUDIT_SCALAR_FIELDS: &[&str] = &[
    "word_count",
    "citation_count",
    "duration_seconds",
    "converted_bytes",
    "count",
    "deleted_count",
    "grounded",
    "preview",
];

/// Words that mean a log line is about captured content. A line containing
/// one keeps its head (timestamp, level, module) and loses its message.
const CONTENT_MARKERS: &[&str] = &[
    "transcript",
    "transcription result",
    "dictated",
    "dictation text",
    "inserted text",
    "insert text",
    "segment text",
    "clipboard",
    "selected text",
    "prompt",
    "summary",
    "notes",
    "utterance",
    "hypothesis",
    "vocabulary",
    "snippet",
];

/// What the bundle contains, in the reader's words. Shown before anything is
/// written and repeated inside the bundle, so the preview and the artifact can
/// never disagree.
pub const INCLUDED_SECTIONS: &[(&str, &str)] = &[
    (
        "README.txt",
        "This list and these rules in prose, so the bundle explains itself to whoever opens it.",
    ),
    (
        "summary.json",
        "Plainsong's version, macOS version, and this Mac's chip, core count, and memory.",
    ),
    (
        "settings-redacted.json",
        "Your settings with every free-text value, path, and credential removed. Switches and engine names survive; what you typed does not.",
    ),
    (
        "readiness.json",
        "Whether macOS currently allows Plainsong the microphone, speech recognition, accessibility, and typing into other apps.",
    ),
    (
        "models.json",
        "Which model files are on this Mac, how large they are, and whether each one passed Plainsong's integrity check.",
    ),
    (
        "audit-log-tail.json",
        "The most recent entries of the local audit log: what happened and when, never what was said.",
    ),
    (
        "logs-redacted.txt",
        "The last few hundred lines the app and the sidecar logged, with paths, addresses, keys, and any line about captured text removed.",
    ),
    (
        "build-identity.json",
        "What this build can prove about itself: app and Electron versions, whether it is a packaged app, and whether it is running from a disk image.",
    ),
    (
        "manifest.json",
        "This list, the redaction rules, and the time the bundle was made.",
    ),
];

/// The rules, in the reader's words.
pub const REDACTION_RULES: &[&str] = &[
    "Anything that is not a yes/no, a number, or a short name is removed.",
    "Email addresses, API keys, and access tokens are removed wherever they appear.",
    "Paths that contain your account name are removed, not shortened.",
    "Lists you filled in — prompts, dictionary entries, snippets — are reduced to how many entries they hold.",
    "A log line that mentions transcripts, dictation, notes, prompts, or the clipboard keeps its timestamp and loses its message.",
];

/// Things the bundle never contains, whatever else changes.
pub const EXCLUDED_BY_DESIGN: &[&str] = &[
    "audio, in any form",
    "transcripts, dictated text, and anything inserted into another app",
    "meeting titles, notes, summaries, and action items",
    "your prompts, dictionary entries, and snippets",
    "API keys, tokens, cookies, and anything in the macOS keychain",
    "the clipboard and the current selection",
    "file names and full filesystem paths",
    "email addresses, account names, and host names",
];

static EMAIL_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
        .expect("email pattern is valid")
});

/// A path under a home directory, including the parts of it that follow a
/// space.
///
/// The obvious pattern -- stop at the first whitespace -- leaves the tail of
/// `~/Library/Application Support/Plainsong/models/base.bin` in the clear,
/// which is a file name, and file names are on the never-included list. So
/// after the first run this keeps consuming space-separated tokens for as long
/// as they still look like path segments (they contain a `/`). A trailing
/// prose word with no slash in it ends the match, so "in 42ms" survives and
/// the path does not.
static HOME_PATH_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r#"(?i)(?:/Users/|/home/|[A-Za-z]:\\Users\\)[^\s"',;)\]}]*(?: [^\s"',;)\]}]*/[^\s"',;)\]}]*)*"#,
    )
    .expect("home path pattern is valid")
});

static API_KEY_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    // Two shapes: a vendor-prefixed key, and any long opaque run that is not a
    // word. The second is deliberately blunt — a false positive costs a
    // diagnostic string, a false negative costs a credential.
    regex::Regex::new(
        r"(?:sk|pk|rk|api|key|ghp|gho|xox[abps])[-_][A-Za-z0-9_\-]{16,}|\b[A-Za-z0-9_\-]{40,}\b",
    )
    .expect("api key pattern is valid")
});

/// A quoted run longer than 24 characters is assumed to be captured content.
static QUOTED_RUN_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#""[^"]{25,}"|'[^']{25,}'"#).expect("quoted run pattern is valid")
});

static IDENTIFIER_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^[0-9A-Za-z._:+\-]{1,64}$").expect("identifier pattern is valid")
});

/// True when the key names a credential, whatever the value looks like.
pub fn is_secret_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    SECRET_KEY_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

/// True when the string is short and shaped like a machine identifier: a model
/// id, an enum variant, a shortcut, a version. Nothing with a space, a slash,
/// or an `@` in it qualifies.
pub fn is_identifier_like(value: &str) -> bool {
    IDENTIFIER_RE.is_match(value)
}

/// Rewrite the parts of a string that are never safe to share, leaving the
/// rest alone. Used on app-authored strings (log lines, diagnostic notes)
/// where the surrounding text is worth keeping.
pub fn redact_text(input: &str) -> String {
    let stage = HOME_PATH_RE.replace_all(input, "[redacted:path]");
    let stage = EMAIL_RE.replace_all(&stage, "[redacted:email]");
    let stage = API_KEY_RE.replace_all(&stage, "[redacted:key]");
    QUOTED_RUN_RE
        .replace_all(&stage, "\"[redacted:text]\"")
        .into_owned()
}

fn truncate_chars(input: &str, max: usize) -> String {
    if input.chars().count() <= max {
        return input.to_string();
    }
    let kept: String = input.chars().take(max).collect();
    format!("{kept}…[truncated]")
}

/// True when a log line names something that could be captured content.
pub fn mentions_captured_content(line: &str) -> bool {
    let lowered = line.to_ascii_lowercase();
    CONTENT_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

/// Everything up to and including the module path a `tracing` line starts
/// with, so a dropped line still says when it happened and who logged it.
fn log_line_head(line: &str) -> String {
    // `2026-09-02T19:00:00.000000Z  INFO plainsong_lib::asr: message`
    // `[sidecar] 2026-09-02T... INFO ...: message`
    match line.find(": ") {
        Some(index) if index <= 120 => line[..index].to_string(),
        _ => line.chars().take(48).collect(),
    }
}

/// Redact one log line. A line that mentions captured content keeps only its
/// head; every other line keeps its message with paths, addresses, keys, and
/// long quoted runs rewritten.
pub fn redact_log_line(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return String::new();
    }
    if mentions_captured_content(trimmed) {
        let head = redact_text(&log_line_head(trimmed));
        return format!("{head}: [redacted: this line mentioned captured text]");
    }
    truncate_chars(&redact_text(trimmed), MAX_LOG_LINE_CHARS)
}

/// The last [`MAX_LOG_LINES`] lines, redacted, blank lines dropped.
pub fn redact_log_lines(lines: &[String]) -> Vec<String> {
    let start = lines.len().saturating_sub(MAX_LOG_LINES);
    lines[start..]
        .iter()
        .map(|line| redact_log_line(line))
        .filter(|line| !line.is_empty())
        .collect()
}

/// Redact a settings tree.
///
/// Fails closed: an unrecognised string is dropped, and a list becomes its
/// length. Only booleans, numbers, and identifier-shaped strings survive.
pub fn redact_settings(value: &Value) -> Value {
    redact_settings_entry(None, value)
}

fn redact_settings_entry(key: Option<&str>, value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => {
            if key.is_some_and(is_secret_key) {
                Value::String(REDACTED.to_string())
            } else if is_identifier_like(text) {
                Value::String(text.clone())
            } else {
                Value::String(REDACTED.to_string())
            }
        }
        Value::Array(items) => {
            let mut summary = Map::new();
            summary.insert("count".to_string(), Value::from(items.len()));
            Value::Object(summary)
        }
        Value::Object(fields) => {
            let mut out = Map::new();
            for (field_key, field_value) in fields {
                out.insert(
                    field_key.clone(),
                    redact_settings_entry(Some(field_key.as_str()), field_value),
                );
            }
            Value::Object(out)
        }
    }
}

/// Redact a tree of strings Plainsong wrote itself — permission notes, insert
/// strategies, failure reasons.
///
/// Unlike [`redact_settings`] this keeps sentences, because these sentences
/// come from the app's own source rather than from the reader. It still
/// rewrites paths, addresses, and keys, and it still keeps lists rather than
/// counting them, because the list contents are enum variants.
pub fn redact_diagnostics(value: &Value) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(text) => Value::String(truncate_chars(&redact_text(text), MAX_NOTE_CHARS)),
        Value::Array(items) => Value::Array(items.iter().map(redact_diagnostics).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, field)| {
                    let redacted = if is_secret_key(key) {
                        Value::String(REDACTED.to_string())
                    } else {
                        redact_diagnostics(field)
                    };
                    (key.clone(), redacted)
                })
                .collect(),
        ),
    }
}

fn redact_audit_details(details: &Value) -> Value {
    if details.is_null() {
        return Value::Null;
    }
    let Value::Object(fields) = details else {
        return Value::String(REDACTED.to_string());
    };

    Value::Object(
        fields
            .iter()
            .map(|(key, value)| {
                let redacted = if AUDIT_IDENTIFIER_FIELDS.contains(&key.as_str()) {
                    match value {
                        Value::String(text) if is_identifier_like(text) => value.clone(),
                        _ => Value::String(REDACTED.to_string()),
                    }
                } else if AUDIT_SCALAR_FIELDS.contains(&key.as_str()) {
                    match value {
                        Value::Bool(_) | Value::Number(_) => value.clone(),
                        _ => Value::String(REDACTED.to_string()),
                    }
                } else {
                    Value::String(REDACTED.to_string())
                };
                (key.clone(), redacted)
            })
            .collect(),
    )
}

/// Redact the tail of the audit log: the event name and severity survive, and
/// details survive only through an explicit allowlist of non-content fields.
pub fn redact_audit_entries(entries: &[Value]) -> Vec<Value> {
    let start = entries.len().saturating_sub(MAX_AUDIT_ENTRIES);
    entries[start..]
        .iter()
        .map(|entry| {
            let mut out = Map::new();
            for field in ["id", "timestamp", "event", "severity"] {
                if let Some(value) = entry.get(field) {
                    out.insert(field.to_string(), redact_settings_entry(Some(field), value));
                }
            }
            let details = entry.get("details").unwrap_or(&Value::Null);
            out.insert("details".to_string(), redact_audit_details(details));
            Value::Object(out)
        })
        .collect()
}

/// One file inside the zip.
#[derive(Debug, Clone)]
pub struct BundleFile {
    pub name: String,
    pub contents: String,
}

/// Everything the bundle is made of, already redacted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundlePreview {
    pub schema_version: u32,
    /// `(file name, what it holds)`, in the order the manifest lists them.
    pub sections: Vec<BundleSection>,
    pub redaction_rules: Vec<String>,
    pub excluded_by_design: Vec<String>,
    pub log_line_count: usize,
    pub audit_entry_count: usize,
    pub model_artifact_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSection {
    pub file: String,
    pub description: String,
}

/// The section list, built once so the preview and the manifest share it.
pub fn sections() -> Vec<BundleSection> {
    INCLUDED_SECTIONS
        .iter()
        .map(|(file, description)| BundleSection {
            file: (*file).to_string(),
            description: (*description).to_string(),
        })
        .collect()
}

/// The plain-text README that ships inside the zip, so the bundle explains
/// itself to whoever opens it without the app in front of them.
pub fn readme(generated_at: &str) -> String {
    let mut out = String::new();
    out.push_str("Plainsong support bundle\n");
    out.push_str("========================\n\n");
    out.push_str(&format!("Made on this Mac at {generated_at}.\n\n"));
    out.push_str("What is in here\n---------------\n");
    for (file, description) in INCLUDED_SECTIONS {
        out.push_str(&format!("- {file}: {description}\n"));
    }
    out.push_str("\nHow it was redacted\n-------------------\n");
    for rule in REDACTION_RULES {
        out.push_str(&format!("- {rule}\n"));
    }
    out.push_str("\nWhat is never in here\n---------------------\n");
    for excluded in EXCLUDED_BY_DESIGN {
        out.push_str(&format!("- {excluded}\n"));
    }
    out.push_str(
        "\nRead it before you send it. Everything in it is a file you can open\n\
         in TextEdit.\n",
    );
    out
}

/// Assemble the files. `settings`, `readiness`, `models`, `audit` and `host`
/// are the raw values; this function is what redacts them.
#[allow(clippy::too_many_arguments)]
pub fn build_files(
    generated_at: &str,
    host: &Value,
    build_identity: &Value,
    settings: &Value,
    readiness: &Value,
    models: &Value,
    audit_entries: &[Value],
    log_lines: &[String],
) -> Vec<BundleFile> {
    let redacted_logs = redact_log_lines(log_lines);
    let redacted_audit = redact_audit_entries(audit_entries);

    let manifest = serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "sections": sections(),
        "redactionRules": REDACTION_RULES,
        "excludedByDesign": EXCLUDED_BY_DESIGN,
        "counts": {
            "logLines": redacted_logs.len(),
            "auditEntries": redacted_audit.len(),
        },
    });

    vec![
        BundleFile {
            name: "README.txt".to_string(),
            contents: readme(generated_at),
        },
        BundleFile {
            name: "manifest.json".to_string(),
            contents: pretty(&manifest),
        },
        BundleFile {
            name: "summary.json".to_string(),
            contents: pretty(&redact_diagnostics(host)),
        },
        BundleFile {
            name: "build-identity.json".to_string(),
            contents: pretty(&redact_diagnostics(build_identity)),
        },
        BundleFile {
            name: "settings-redacted.json".to_string(),
            contents: pretty(&redact_settings(settings)),
        },
        BundleFile {
            name: "readiness.json".to_string(),
            contents: pretty(&redact_diagnostics(readiness)),
        },
        BundleFile {
            name: "models.json".to_string(),
            contents: pretty(&redact_diagnostics(models)),
        },
        BundleFile {
            name: "audit-log-tail.json".to_string(),
            contents: pretty(&Value::Array(redacted_audit)),
        },
        BundleFile {
            name: "logs-redacted.txt".to_string(),
            contents: format!("{}\n", redacted_logs.join("\n")),
        },
    ]
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
}

/// The last check before anything is written: no assembled file may still
/// contain a home path or an email address.
///
/// This is the same idea as the script's `unsafePathPattern` guard, hoisted to
/// cover every file rather than one JSON blob, and it is a hard failure — a
/// bundle that trips it is not written at all.
pub fn find_leak(files: &[BundleFile]) -> Option<String> {
    for file in files {
        if let Some(found) = HOME_PATH_RE.find(&file.contents) {
            return Some(format!(
                "{} still contained a path under a home directory ({}…)",
                file.name,
                found.as_str().chars().take(12).collect::<String>()
            ));
        }
        if EMAIL_RE.is_match(&file.contents) {
            return Some(format!("{} still contained an email address", file.name));
        }
    }
    None
}

/// Write the assembled files to `destination` as a zip.
///
/// Refuses to write anything if [`find_leak`] finds a home path or an address
/// in the assembled text, so a redaction bug becomes a visible failure rather
/// than a file the reader forwards to a stranger.
pub fn write_bundle(destination: &Path, files: &[BundleFile]) -> Result<()> {
    if let Some(leak) = find_leak(files) {
        anyhow::bail!("Support bundle was not written: {leak}");
    }
    crate::safe_fs::atomic_replace_with(destination, |file| {
        use zip::write::SimpleFileOptions;
        use zip::CompressionMethod;

        let mut zip = zip::ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for entry in files {
            zip.start_file(entry.name.as_str(), options)
                .with_context(|| format!("Failed to add {} to the support bundle", entry.name))?;
            zip.write_all(entry.contents.as_bytes()).with_context(|| {
                format!("Failed to write {} into the support bundle", entry.name)
            })?;
        }
        zip.finish()
            .context("Failed to finalize the support bundle archive")?;
        Ok(())
    })
    .with_context(|| {
        format!(
            "Failed to write the support bundle to {}",
            destination.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_settings() -> Value {
        serde_json::json!({
            "theme": "system",
            "transcription": {
                "dictationModelId": "parakeet-tdt-0.6b-v3",
                "dictationProvider": "parakeet",
                "useSharedAsrSelection": true,
                "vocabularyHints": ["Plainsong", "Nautilus", "Jonathan Reed"],
            },
            "privacy": {
                "openaiApiKey": "sk-proj-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
                "exportRoot": "/Users/jonathanreed/Documents/Plainsong",
                "remoteProcessingEnabled": false,
                "supportEmail": "jonathanrayreed@gmail.com",
            },
            "ai": {
                "savedPrompts": [
                    { "id": "p1", "text": "Summarize what we decided about the launch date" },
                ],
            },
        })
    }

    #[test]
    fn settings_redaction_keeps_switches_and_engine_names() {
        let redacted = redact_settings(&fixture_settings());
        assert_eq!(redacted["theme"], Value::String("system".into()));
        assert_eq!(
            redacted["transcription"]["dictationModelId"],
            Value::String("parakeet-tdt-0.6b-v3".into())
        );
        assert_eq!(
            redacted["transcription"]["useSharedAsrSelection"],
            Value::Bool(true)
        );
        assert_eq!(
            redacted["privacy"]["remoteProcessingEnabled"],
            Value::Bool(false)
        );
    }

    #[test]
    fn settings_redaction_drops_keys_paths_addresses_and_lists() {
        let redacted = redact_settings(&fixture_settings());
        assert_eq!(
            redacted["privacy"]["openaiApiKey"],
            Value::String(REDACTED.into())
        );
        assert_eq!(
            redacted["privacy"]["exportRoot"],
            Value::String(REDACTED.into())
        );
        assert_eq!(
            redacted["privacy"]["supportEmail"],
            Value::String(REDACTED.into())
        );
        // A list the reader filled in becomes its length, never its contents.
        assert_eq!(
            redacted["transcription"]["vocabularyHints"]["count"],
            Value::from(3)
        );
        assert_eq!(redacted["ai"]["savedPrompts"]["count"], Value::from(1));

        let serialized = redacted.to_string();
        assert!(!serialized.contains("Jonathan Reed"));
        assert!(!serialized.contains("launch date"));
        assert!(!serialized.contains("jonathanrayreed"));
        assert!(!serialized.contains("/Users/"));
        assert!(!serialized.contains("sk-proj"));
    }

    #[test]
    fn an_unknown_free_text_settings_field_is_dropped_by_default() {
        // The point of failing closed: nobody has to remember to add this key
        // to a denylist for it to be safe.
        let redacted = redact_settings(&serde_json::json!({
            "somethingAddedNextMonth": "the neighbours are away until Tuesday",
        }));
        assert_eq!(
            redacted["somethingAddedNextMonth"],
            Value::String(REDACTED.into())
        );
    }

    #[test]
    fn log_redaction_removes_home_paths_addresses_and_keys() {
        let line = "2026-09-02T19:00:00.000000Z  INFO plainsong_lib::download: fetched \
                    /Users/jonathanreed/Library/Application Support/Plainsong/models/base.bin";
        let redacted = redact_log_line(line);
        assert!(redacted.contains("[redacted:path]"), "{redacted}");
        assert!(!redacted.contains("jonathanreed"), "{redacted}");

        let with_address = redact_log_line("WARN mail: invite sent to jonathanrayreed@gmail.com");
        assert!(with_address.contains("[redacted:email]"), "{with_address}");

        let with_key =
            redact_log_line("WARN llm: provider rejected sk-ant-AAAABBBBCCCCDDDDEEEEFFFF1234");
        assert!(with_key.contains("[redacted:key]"), "{with_key}");
    }

    #[test]
    fn a_home_path_with_a_space_in_it_is_redacted_whole() {
        // ~/Library/Application Support/... : the space used to end the match
        // and leave the file name behind.
        let redacted = redact_log_line(
            "INFO plainsong_lib::download: staged \
             /Users/jonathanreed/Library/Application Support/Plainsong/models/base.bin",
        );
        assert!(!redacted.contains("base.bin"), "{redacted}");
        assert!(!redacted.contains("jonathanreed"), "{redacted}");

        // A prose word after the path is not swallowed with it.
        let with_tail = redact_log_line("INFO opened /Users/jonathanreed/x.txt in 42ms");
        assert!(with_tail.contains("in 42ms"), "{with_tail}");
        assert!(!with_tail.contains("x.txt"), "{with_tail}");
    }

    #[test]
    fn a_log_line_about_captured_text_keeps_only_its_head() {
        let line = "2026-09-02T19:00:00.000000Z  INFO plainsong_lib::asr: transcript is \
                    'we agreed to ship on the fourteenth'";
        let redacted = redact_log_line(line);
        assert!(redacted.contains("plainsong_lib::asr"), "{redacted}");
        assert!(
            redacted.contains("[redacted: this line mentioned captured text]"),
            "{redacted}"
        );
        assert!(!redacted.contains("fourteenth"), "{redacted}");
    }

    #[test]
    fn log_lines_are_capped_at_the_documented_tail() {
        let lines: Vec<String> = (0..MAX_LOG_LINES + 50)
            .map(|index| format!("INFO plainsong_lib: step {index}"))
            .collect();
        let redacted = redact_log_lines(&lines);
        assert_eq!(redacted.len(), MAX_LOG_LINES);
        assert!(redacted[0].contains(&format!("step {}", 50)));
    }

    #[test]
    fn audit_details_go_through_the_strict_policy() {
        let entries = vec![serde_json::json!({
            "id": "a1",
            "timestamp": "2026-09-02T19:00:00Z",
            "event": "dictation_completed",
            "severity": "info",
            "details": {
                "recording_id": "rec-123",
                "word_count": 42,
                "text": "we agreed to ship on the fourteenth",
                "path": "/Users/jonathanreed/Desktop/note.txt",
            },
        })];
        let redacted = redact_audit_entries(&entries);
        assert_eq!(redacted.len(), 1);
        assert_eq!(
            redacted[0]["event"],
            Value::String("dictation_completed".into())
        );
        assert_eq!(redacted[0]["details"]["word_count"], Value::from(42));
        assert_eq!(
            redacted[0]["details"]["text"],
            Value::String(REDACTED.into())
        );
        assert_eq!(
            redacted[0]["details"]["path"],
            Value::String(REDACTED.into())
        );
    }

    #[test]
    fn audit_details_redact_identifier_shaped_content_fields() {
        let entries = vec![serde_json::json!({
            "event": "analysis_completed",
            "details": {
                "recording_id": "rec-123",
                "query": "HIV",
                "new_title": "ProjectPhoenix",
                "source_file_name": "Patient-HIV.wav",
                "model": "local-model-v1",
                "citation_count": 3,
                "unknown_future_field": "LooksLikeAnIdentifier",
            },
        })];

        let details = &redact_audit_entries(&entries)[0]["details"];
        assert_eq!(details["recording_id"], "rec-123");
        assert_eq!(details["model"], "local-model-v1");
        assert_eq!(details["citation_count"], 3);
        for field in [
            "query",
            "new_title",
            "source_file_name",
            "unknown_future_field",
        ] {
            assert_eq!(details[field], REDACTED, "{field} must fail closed");
        }
    }

    #[test]
    fn audit_tail_is_capped() {
        let entries: Vec<Value> = (0..MAX_AUDIT_ENTRIES + 10)
            .map(|index| serde_json::json!({ "id": format!("a{index}"), "event": "startup" }))
            .collect();
        assert_eq!(redact_audit_entries(&entries).len(), MAX_AUDIT_ENTRIES);
    }

    #[test]
    fn diagnostics_keep_app_authored_sentences_but_lose_paths() {
        let readiness = serde_json::json!({
            "microphoneReady": true,
            "availableInsertStrategies": ["accessibility_direct_text", "simulated_typing"],
            "appBundlePath": "/Users/jonathanreed/Applications/Plainsong.app",
            "notes": ["Accessibility is allowed, so text can be typed into other apps."],
        });
        let redacted = redact_diagnostics(&readiness);
        assert_eq!(redacted["microphoneReady"], Value::Bool(true));
        assert_eq!(
            redacted["availableInsertStrategies"][1],
            Value::String("simulated_typing".into())
        );
        assert_eq!(
            redacted["appBundlePath"],
            Value::String("[redacted:path]".into())
        );
        assert!(redacted["notes"][0]
            .as_str()
            .unwrap()
            .contains("text can be typed"));
    }

    #[test]
    fn the_manifest_lists_every_file_the_bundle_writes() {
        let files = build_files(
            "2026-09-02T19:00:00Z",
            &serde_json::json!({ "platform": "darwin" }),
            &serde_json::json!({ "appVersion": "0.9.0-beta.3" }),
            &fixture_settings(),
            &serde_json::json!({ "microphoneReady": true }),
            &serde_json::json!({ "artifacts": [] }),
            &[],
            &[],
        );
        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        for (section, _) in INCLUDED_SECTIONS {
            assert!(
                names.contains(section),
                "{section} is described but not written"
            );
        }
        // Exactly the described set, no more: the count the Settings screen
        // shows is the count the zip holds.
        assert_eq!(names.len(), INCLUDED_SECTIONS.len());
    }

    #[test]
    fn the_leak_guard_catches_a_path_that_survived_redaction() {
        let files = vec![BundleFile {
            name: "logs-redacted.txt".to_string(),
            contents: "INFO wrote /Users/jonathanreed/Desktop/note.txt".to_string(),
        }];
        let leak = find_leak(&files).expect("a home path must be caught");
        assert!(leak.contains("logs-redacted.txt"), "{leak}");
    }

    #[test]
    fn a_bundle_built_from_hostile_fixtures_has_no_leak() {
        let files = build_files(
            "2026-09-02T19:00:00Z",
            &serde_json::json!({ "platform": "darwin", "arch": "arm64" }),
            &serde_json::json!({ "appVersion": "0.9.0-beta.3", "packaged": true }),
            &fixture_settings(),
            &serde_json::json!({
                "appBundlePath": "/Users/jonathanreed/Applications/Plainsong.app",
            }),
            &serde_json::json!({ "artifacts": [{ "file": "encoder_model.onnx", "trusted": true }] }),
            &[serde_json::json!({
                "id": "a1",
                "event": "dictation_completed",
                "details": { "text": "the neighbours are away", "path": "/Users/jonathanreed/x" },
            })],
            &[
                "INFO plainsong_lib: opened /Users/jonathanreed/Library/x".to_string(),
                "INFO mail: invited jonathanrayreed@gmail.com".to_string(),
            ],
        );
        assert_eq!(find_leak(&files), None);
    }

    #[test]
    fn readme_states_the_rules_and_the_exclusions() {
        let text = readme("2026-09-02T19:00:00Z");
        for rule in REDACTION_RULES {
            assert!(text.contains(rule), "README omitted a rule: {rule}");
        }
        for excluded in EXCLUDED_BY_DESIGN {
            assert!(
                text.contains(excluded),
                "README omitted an exclusion: {excluded}"
            );
        }
    }

    #[test]
    fn secret_keys_are_recognised_by_name() {
        assert!(is_secret_key("openaiApiKey"));
        assert!(is_secret_key("access_token"));
        assert!(is_secret_key("vaultPassword"));
        assert!(!is_secret_key("dictationModelId"));
        // "key" alone is a common word in this codebase (`keyboardShortcuts`),
        // so the markers are deliberately more specific than that.
        assert!(!is_secret_key("keyboardShortcuts"));
    }
}
