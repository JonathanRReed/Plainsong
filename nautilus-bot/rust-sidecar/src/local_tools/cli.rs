//! Argument parsing and command execution for the `plainsong` binary.
//!
//! Parsing is hand-rolled over `std::env::args` on purpose: the surface is
//! eight subcommands with a handful of flags, `clap`/`lexopt`/`pico-args` are
//! not in `Cargo.lock`, and a new production dependency for this would be
//! hard to justify against forty lines of matching.

use super::render;
use super::{
    clamp_limit, parse_since, ExportFormat, ListFilter, MeetingSource, DEFAULT_PAGE_SIZE,
    EXIT_NOT_FOUND, MAX_PAGE_SIZE,
};
use std::io::Write;
use std::path::PathBuf;

pub const USAGE: &str = "plainsong - read your Plainsong meetings and dictations from the terminal

USAGE
    plainsong <command> [options]

COMMANDS
    list        [--limit N] [--offset N] [--since DATE|7d|24h] [--project NAME] [--json]
                Meetings and imported recordings, newest first.
    search      <query> [--limit N] [--json]
                Full-text search across transcripts.
    show        <id> [--json]
                Title, date, summary, notes and action items for one meeting.
    transcript  <id> [--json|--srt]
                The transcript with timestamps and speakers.
    export      <id> --format md|json|txt [--out PATH]
                Render a meeting the way the app's Export does.
    dictations  [--limit N] [--offset N] [--json]
                Dictation history, text only.
    stats       [--json]
                Counts and storage facts about the local database.
    mcp         Serve a read-only MCP server on stdin/stdout.

    help, --help, -h        Show this text.
    version, --version, -V  Print the version.

NOTES
    Every command is read-only. The database is opened with SQLite's read-only
    flag; there is no command that writes.
    Requires \"Local tools\" to be turned on in Plainsong > Settings > General.

EXIT CODES
    0 ok   1 error   2 usage   3 local tools are off   4 not found
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptFormat {
    Text,
    Json,
    Srt,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    List {
        limit: usize,
        offset: usize,
        since: Option<String>,
        project: Option<String>,
        json: bool,
    },
    Search {
        query: String,
        limit: usize,
        json: bool,
    },
    Show {
        id: String,
        json: bool,
    },
    Transcript {
        id: String,
        format: TranscriptFormat,
    },
    Export {
        id: String,
        format: ExportFormat,
        out: Option<PathBuf>,
    },
    Dictations {
        limit: usize,
        offset: usize,
        json: bool,
    },
    Stats {
        json: bool,
    },
    Mcp,
    Help,
    Version,
}

impl Command {
    /// Commands that need neither the gate nor the database.
    pub fn is_informational(&self) -> bool {
        matches!(self, Command::Help | Command::Version)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError(pub String);

impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Flags collected from the tail of an argument list.
#[derive(Debug, Default)]
struct Flags {
    positionals: Vec<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    since: Option<String>,
    project: Option<String>,
    format: Option<String>,
    out: Option<PathBuf>,
    json: bool,
    srt: bool,
}

fn parse_flags(args: &[String], allowed: &[&str]) -> Result<Flags, UsageError> {
    let mut flags = Flags::default();
    let mut index = 0;
    let take_value =
        |index: &mut usize, name: &str, inline: Option<&str>| -> Result<String, UsageError> {
            if let Some(value) = inline {
                return Ok(value.to_string());
            }
            *index += 1;
            args.get(*index)
                .cloned()
                .ok_or_else(|| UsageError(format!("{name} needs a value")))
        };
    while index < args.len() {
        let arg = &args[index];
        if !arg.starts_with("--") {
            flags.positionals.push(arg.clone());
            index += 1;
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (arg.as_str(), None),
        };
        if !allowed.contains(&name) {
            return Err(UsageError(format!("unknown option {name}")));
        }
        match name {
            "--json" => flags.json = true,
            "--srt" => flags.srt = true,
            "--limit" => {
                let value = take_value(&mut index, name, inline)?;
                flags.limit =
                    Some(value.parse().map_err(|_| {
                        UsageError(format!("--limit must be a number, got {value}"))
                    })?);
            }
            "--offset" => {
                let value = take_value(&mut index, name, inline)?;
                flags.offset =
                    Some(value.parse().map_err(|_| {
                        UsageError(format!("--offset must be a number, got {value}"))
                    })?);
            }
            "--since" => flags.since = Some(take_value(&mut index, name, inline)?),
            "--project" => flags.project = Some(take_value(&mut index, name, inline)?),
            "--format" => flags.format = Some(take_value(&mut index, name, inline)?),
            "--out" => flags.out = Some(PathBuf::from(take_value(&mut index, name, inline)?)),
            _ => return Err(UsageError(format!("unknown option {name}"))),
        }
        index += 1;
    }
    Ok(flags)
}

fn one_positional(flags: &Flags, what: &str) -> Result<String, UsageError> {
    match flags.positionals.as_slice() {
        [value] if !value.trim().is_empty() => Ok(value.clone()),
        [] => Err(UsageError(format!("missing {what}"))),
        _ => Err(UsageError(format!("expected exactly one {what}"))),
    }
}

/// Parse the arguments after the program name.
pub fn parse_args(args: &[String]) -> Result<Command, UsageError> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Command::Help);
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        return Ok(Command::Version);
    }
    let Some((command, rest)) = args.split_first() else {
        return Err(UsageError("missing command".to_string()));
    };
    match command.as_str() {
        "help" => Ok(Command::Help),
        "version" => Ok(Command::Version),
        "mcp" => {
            if !rest.is_empty() {
                return Err(UsageError("mcp takes no options".to_string()));
            }
            Ok(Command::Mcp)
        }
        "list" => {
            let flags = parse_flags(
                rest,
                &["--limit", "--offset", "--since", "--project", "--json"],
            )?;
            if !flags.positionals.is_empty() {
                return Err(UsageError(format!(
                    "list takes no positional arguments (got {})",
                    flags.positionals.join(" ")
                )));
            }
            Ok(Command::List {
                limit: clamp_limit(flags.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
                offset: flags.offset.unwrap_or(0),
                since: flags.since,
                project: flags.project,
                json: flags.json,
            })
        }
        "search" => {
            let flags = parse_flags(rest, &["--limit", "--json"])?;
            if flags.positionals.is_empty() {
                return Err(UsageError("missing search query".to_string()));
            }
            Ok(Command::Search {
                query: flags.positionals.join(" "),
                limit: clamp_limit(flags.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
                json: flags.json,
            })
        }
        "show" => {
            let flags = parse_flags(rest, &["--json"])?;
            Ok(Command::Show {
                id: one_positional(&flags, "meeting id")?,
                json: flags.json,
            })
        }
        "transcript" => {
            let flags = parse_flags(rest, &["--json", "--srt"])?;
            if flags.json && flags.srt {
                return Err(UsageError("choose one of --json or --srt".to_string()));
            }
            Ok(Command::Transcript {
                id: one_positional(&flags, "meeting id")?,
                format: if flags.json {
                    TranscriptFormat::Json
                } else if flags.srt {
                    TranscriptFormat::Srt
                } else {
                    TranscriptFormat::Text
                },
            })
        }
        "export" => {
            let flags = parse_flags(rest, &["--format", "--out"])?;
            let id = one_positional(&flags, "meeting id")?;
            let format_name = flags
                .format
                .ok_or_else(|| UsageError("export needs --format md|json|txt".to_string()))?;
            let format = ExportFormat::parse(&format_name).ok_or_else(|| {
                UsageError(format!(
                    "unknown export format {format_name}; use md, json or txt"
                ))
            })?;
            Ok(Command::Export {
                id,
                format,
                out: flags.out,
            })
        }
        "dictations" => {
            let flags = parse_flags(rest, &["--limit", "--offset", "--json"])?;
            if !flags.positionals.is_empty() {
                return Err(UsageError(
                    "dictations takes no positional arguments".to_string(),
                ));
            }
            Ok(Command::Dictations {
                limit: clamp_limit(flags.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
                offset: flags.offset.unwrap_or(0),
                json: flags.json,
            })
        }
        "stats" => {
            let flags = parse_flags(rest, &["--json"])?;
            if !flags.positionals.is_empty() {
                return Err(UsageError(
                    "stats takes no positional arguments".to_string(),
                ));
            }
            Ok(Command::Stats { json: flags.json })
        }
        other => Err(UsageError(format!("unknown command {other}"))),
    }
}

fn json_line<T: serde::Serialize>(value: &T) -> anyhow::Result<String> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    Ok(text)
}

/// Run a data command against `source`, writing to `out`. Returns the exit
/// code. `Mcp`, `Help` and `Version` are handled by the binary, not here.
pub fn run(
    command: &Command,
    source: &dyn MeetingSource,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> anyhow::Result<i32> {
    match command {
        Command::List {
            limit,
            offset,
            since,
            project,
            json,
        } => {
            let since = match since {
                Some(raw) => match parse_since(raw, chrono::Utc::now()) {
                    Some(parsed) => Some(parsed),
                    None => {
                        writeln!(
                            err,
                            "--since must be a date (2026-08-01), a timestamp, or a span like 7d / 24h / 30m; got {raw}"
                        )?;
                        return Ok(2);
                    }
                },
                None => None,
            };
            let page = source.list_meetings(&ListFilter {
                limit: *limit,
                offset: *offset,
                since,
                project: project.clone(),
            })?;
            if *json {
                out.write_all(json_line(&page)?.as_bytes())?;
            } else {
                out.write_all(render::render_meeting_list(&page).as_bytes())?;
            }
            Ok(0)
        }
        Command::Search { query, limit, json } => {
            let hits = source.search(query, *limit)?;
            if *json {
                out.write_all(json_line(&hits)?.as_bytes())?;
            } else {
                out.write_all(render::render_search(query, &hits).as_bytes())?;
            }
            Ok(0)
        }
        Command::Show { id, json } => match source.get_meeting(id)? {
            Some(meeting) => {
                if *json {
                    out.write_all(json_line(&meeting)?.as_bytes())?;
                } else {
                    out.write_all(render::render_meeting(&meeting).as_bytes())?;
                }
                Ok(0)
            }
            None => not_found(err, id),
        },
        Command::Transcript { id, format } => match source.get_transcript(id)? {
            Some(transcript) => {
                let text = match format {
                    TranscriptFormat::Json => json_line(&transcript)?,
                    TranscriptFormat::Srt => render::render_srt(&transcript),
                    TranscriptFormat::Text => render::render_transcript_text(&transcript),
                };
                out.write_all(text.as_bytes())?;
                Ok(0)
            }
            None => {
                if source.get_meeting(id)?.is_some() {
                    writeln!(err, "Meeting {id} has no transcript stored.")?;
                    Ok(EXIT_NOT_FOUND)
                } else {
                    not_found(err, id)
                }
            }
        },
        Command::Export {
            id,
            format,
            out: target,
        } => match source.export_meeting(id, *format)? {
            Some(rendered) => {
                match target {
                    Some(path) => {
                        std::fs::write(path, rendered.as_bytes()).map_err(|error| {
                            anyhow::anyhow!("Could not write {}: {error}", path.display())
                        })?;
                        writeln!(out, "Wrote {}", path.display())?;
                    }
                    None => out.write_all(rendered.as_bytes())?,
                }
                Ok(0)
            }
            None => not_found(err, id),
        },
        Command::Dictations {
            limit,
            offset,
            json,
        } => {
            let page = source.list_dictations(*limit, *offset)?;
            if *json {
                out.write_all(json_line(&page)?.as_bytes())?;
            } else {
                out.write_all(render::render_dictations(&page).as_bytes())?;
            }
            Ok(0)
        }
        Command::Stats { json } => {
            let stats = source.stats()?;
            if *json {
                out.write_all(json_line(&stats)?.as_bytes())?;
            } else {
                out.write_all(render::render_stats(&stats).as_bytes())?;
            }
            Ok(0)
        }
        Command::Mcp | Command::Help | Command::Version => {
            anyhow::bail!("{command:?} is not a data command")
        }
    }
}

fn not_found(err: &mut dyn Write, id: &str) -> anyhow::Result<i32> {
    writeln!(
        err,
        "No meeting with id {id}. Run `plainsong list` to see ids."
    )?;
    Ok(EXIT_NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_tools::test_support::FakeSource;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_every_subcommand() {
        assert_eq!(
            parse_args(&args(&[
                "list",
                "--limit",
                "5",
                "--since",
                "7d",
                "--project",
                "Work",
                "--json"
            ]))
            .unwrap(),
            Command::List {
                limit: 5,
                offset: 0,
                since: Some("7d".to_string()),
                project: Some("Work".to_string()),
                json: true
            }
        );
        assert_eq!(
            parse_args(&args(&["list", "--limit=500", "--offset=40"])).unwrap(),
            Command::List {
                limit: MAX_PAGE_SIZE,
                offset: 40,
                since: None,
                project: None,
                json: false
            }
        );
        assert_eq!(
            parse_args(&args(&["search", "ship", "date", "--limit", "3"])).unwrap(),
            Command::Search {
                query: "ship date".to_string(),
                limit: 3,
                json: false
            }
        );
        assert_eq!(
            parse_args(&args(&["show", "abc", "--json"])).unwrap(),
            Command::Show {
                id: "abc".to_string(),
                json: true
            }
        );
        assert_eq!(
            parse_args(&args(&["transcript", "abc", "--srt"])).unwrap(),
            Command::Transcript {
                id: "abc".to_string(),
                format: TranscriptFormat::Srt
            }
        );
        assert_eq!(
            parse_args(&args(&[
                "export",
                "abc",
                "--format",
                "md",
                "--out",
                "/tmp/x.md"
            ]))
            .unwrap(),
            Command::Export {
                id: "abc".to_string(),
                format: ExportFormat::Markdown,
                out: Some(PathBuf::from("/tmp/x.md"))
            }
        );
        assert_eq!(
            parse_args(&args(&["dictations", "--limit", "0"])).unwrap(),
            Command::Dictations {
                limit: 1,
                offset: 0,
                json: false
            }
        );
        assert_eq!(
            parse_args(&args(&["stats"])).unwrap(),
            Command::Stats { json: false }
        );
        assert_eq!(parse_args(&args(&["mcp"])).unwrap(), Command::Mcp);
        assert_eq!(parse_args(&args(&["help"])).unwrap(), Command::Help);
        assert_eq!(
            parse_args(&args(&["list", "--help"])).unwrap(),
            Command::Help
        );
        assert_eq!(parse_args(&args(&["-V"])).unwrap(), Command::Version);
    }

    #[test]
    fn rejects_bad_usage_with_a_reason() {
        let cases: &[(&[&str], &str)] = &[
            (&[], "missing command"),
            (&["frobnicate"], "unknown command frobnicate"),
            (&["list", "--bogus"], "unknown option --bogus"),
            (&["list", "--limit"], "--limit needs a value"),
            (&["list", "--limit", "many"], "--limit must be a number"),
            (&["list", "extra"], "no positional arguments"),
            (&["search"], "missing search query"),
            (&["show"], "missing meeting id"),
            (&["show", "a", "b"], "exactly one meeting id"),
            (&["transcript", "a", "--json", "--srt"], "choose one"),
            (&["export", "a"], "needs --format"),
            (
                &["export", "a", "--format", "pdf"],
                "unknown export format pdf",
            ),
            (&["mcp", "--json"], "mcp takes no options"),
        ];
        for (input, expected) in cases {
            let error = parse_args(&args(input)).unwrap_err();
            assert!(
                error.0.contains(expected),
                "{input:?}: expected {expected:?} in {:?}",
                error.0
            );
        }
    }

    #[test]
    fn there_is_no_write_command() {
        for verb in [
            "delete", "rm", "rename", "edit", "set", "import", "record", "start", "stop",
        ] {
            assert!(
                parse_args(&args(&[verb, "x"])).is_err(),
                "{verb} must not parse"
            );
        }
        assert!(!USAGE.contains("delete"));
    }

    fn run_capture(command: Command) -> (i32, String, String) {
        let source = FakeSource::sample();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&command, &source, &mut out, &mut err).unwrap();
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    #[test]
    fn list_show_transcript_and_stats_render_text_and_json() {
        let (code, out, _) = run_capture(Command::List {
            limit: 2,
            offset: 0,
            since: None,
            project: None,
            json: false,
        });
        assert_eq!(code, 0);
        assert!(out.contains("1:1"));
        assert!(out.contains("2 of 3 shown"));

        let (code, out, _) = run_capture(Command::List {
            limit: 2,
            offset: 0,
            since: Some("2026-08-20T12:00:00Z".to_string()),
            project: None,
            json: true,
        });
        assert_eq!(code, 0);
        let page: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(page["total"], 1);
        assert_eq!(page["items"][0]["id"], "m3");

        let (code, _, err) = run_capture(Command::List {
            limit: 2,
            offset: 0,
            since: Some("last tuesday".to_string()),
            project: None,
            json: false,
        });
        assert_eq!(code, 2);
        assert!(err.contains("--since must be"));

        let (code, out, _) = run_capture(Command::Show {
            id: "m1".to_string(),
            json: false,
        });
        assert_eq!(code, 0);
        assert!(out.starts_with("Planning\n"));
        assert!(out.contains("- Send the deck"));

        let (code, out, _) = run_capture(Command::Transcript {
            id: "m1".to_string(),
            format: TranscriptFormat::Srt,
        });
        assert_eq!(code, 0);
        assert!(out.starts_with("1\n00:00:00,000 --> 00:00:01,500\n"));

        let (code, out, _) = run_capture(Command::Stats { json: true });
        assert_eq!(code, 0);
        let stats: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(stats["meetings"], 3);

        let (code, out, _) = run_capture(Command::Dictations {
            limit: 2,
            offset: 0,
            json: false,
        });
        assert_eq!(code, 0);
        assert!(out.contains("Dictation number 2"));
        assert!(out.contains("2 of 3 shown"));

        let (code, out, _) = run_capture(Command::Search {
            query: "segment 3".to_string(),
            limit: 5,
            json: false,
        });
        assert_eq!(code, 0);
        assert!(out.contains("m1"));
    }

    #[test]
    fn missing_ids_exit_four_with_a_hint() {
        let (code, _, err) = run_capture(Command::Show {
            id: "nope".to_string(),
            json: false,
        });
        assert_eq!(code, EXIT_NOT_FOUND);
        assert!(err.contains("plainsong list"));

        // m3 exists but has no transcript: still 4, but the message differs.
        let (code, _, err) = run_capture(Command::Transcript {
            id: "m3".to_string(),
            format: TranscriptFormat::Text,
        });
        assert_eq!(code, EXIT_NOT_FOUND);
        assert!(err.contains("no transcript stored"));
    }

    #[test]
    fn export_writes_the_requested_file() {
        let dir = crate::test_fs::TempDir::new("local-tools");
        let target = dir.path().join("planning.md");
        let (code, out, _) = run_capture(Command::Export {
            id: "m1".to_string(),
            format: ExportFormat::Markdown,
            out: Some(target.clone()),
        });
        assert_eq!(code, 0);
        assert!(out.contains("Wrote"));
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "# Planning (md)");

        let (code, out, _) = run_capture(Command::Export {
            id: "m1".to_string(),
            format: ExportFormat::Text,
            out: None,
        });
        assert_eq!(code, 0);
        assert_eq!(out, "# Planning (txt)");
    }
}
