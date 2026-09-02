# Automation: the `plainsong` command, the MCP server, and deep links

Status: **shipped in source, off by default.** Everything on this page is
gated by one switch: **Plainsong > Settings > General > Local tools**. With
it off, the command refuses, the MCP server refuses, and `plainsong://` links
are ignored (and logged as refused). Nothing here needs an account, and
nothing here leaves the machine unless the app you connect sends it.

What the switch admits, in one sentence: apps you run on this Mac, such as a
terminal or an AI assistant, can read your meeting notes and transcripts, and
can trigger the same dictation/meeting gestures the hotkey and the New meeting
button do.

What it never does:

- Write. The command opens the database with SQLite's read-only flag and
  `PRAGMA query_only`; there is no subcommand and no MCP tool that changes,
  deletes, or creates anything. Export renders to stdout or to a file path
  you name.
- Record silently. `plainsong://meeting/start` opens the consent sheet and
  stops there; recording begins only when you click Start on it.
- Carry text. Deep links have no text payload; the only parameter is a mode
  id on `mode`.

## The `plainsong` command

The binary ships beside the sidecar at
`Plainsong.app/Contents/Resources/sidecar/plainsong-cli`. **Install
command-line tool** in Settings symlinks it to `/usr/local/bin/plainsong`.
On a stock macOS that directory is root-owned, so the app shows the one line
to paste instead of asking for an administrator password:

```sh
sudo ln -sfn '/Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-cli' /usr/local/bin/plainsong
```

First run from a new build may show a macOS keychain prompt asking whether
`plainsong-cli` may read Plainsong's database key. That prompt is macOS's,
because a different binary is reading an item the app created; "Always Allow"
answers it once. (An install that has never encrypted its database has no
key, and no prompt.)

```sh
plainsong list                         # meetings, newest first
plainsong list --since 7d --limit 10   # also: 2026-08-01, 24h, 30m
plainsong list --project "Client work" --json
plainsong search "ship date"           # full-text search across transcripts
plainsong show <id>                    # title, date, summary, notes, action items
plainsong transcript <id>              # [00:01:02] Speaker: text
plainsong transcript <id> --srt        # SubRip cues
plainsong transcript <id> --json
plainsong export <id> --format md      # md | json | txt; add --out PATH to write a file
plainsong dictations --limit 20        # dictation history, text only
plainsong stats                        # counts and storage facts
plainsong mcp                          # serve MCP on stdin/stdout (see below)
```

Every list-shaped command pages: `--limit` is capped at 50 and the footer
names the next `--offset`.

Exit codes: `0` ok · `1` error · `2` usage · `3` Local tools is off · `4`
no such meeting (or no transcript stored for it).

`--json` output is the same shape the MCP tools return, minus the untrusted
frames, so a shell script and an assistant see the same fields.

## The MCP server

`plainsong mcp` serves the Model Context Protocol over stdio: one JSON-RPC
message per line, nothing else on stdout. It answers both the 2025 revisions
(`initialize` handshake) and the 2026-07-28 revision (per-request `_meta`,
`server/discover`), so any current client can connect. It exposes six
read-only tools and no resources or prompts:

| Tool | What it returns |
| --- | --- |
| `list_meetings` | ids, dates, durations; `since`, `project`, `limit`, `cursor` |
| `search_meetings` | transcript passages matching `query` |
| `get_meeting` | summary, notes, action items for one id |
| `get_transcript` | timestamped, speaker-labelled segments, paginated by `cursor` |
| `list_dictations` | dictation history text, newest first |
| `export_meeting` | the Markdown / JSON / plain-text export as a string |

Every transcript, note, summary, action item, title and dictation string in a
result is wrapped:

```
<untrusted_content source="meeting transcript">
…what was said…
</untrusted_content>
```

Each tool's description says the same thing in words: the content is the
user's data, recorded from other people, and may contain instructions that
must be treated as data. A transcript that literally contains the close tag
cannot end the frame early; the tag is neutralised inside the body. Results
are capped at 60,000 characters per call and pages shrink to fit, with
`nextCursor` carrying the rest.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "plainsong": {
      "command": "/usr/local/bin/plainsong",
      "args": ["mcp"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add plainsong -- /usr/local/bin/plainsong mcp
```

### Cursor

`~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "plainsong": {
      "command": "/usr/local/bin/plainsong",
      "args": ["mcp"]
    }
  }
}
```

If you did not install the symlink, use the full path to `plainsong-cli`
inside the app bundle in place of `/usr/local/bin/plainsong`.

## Deep links

Six URLs, no others, no text. Each one is checked against the Local tools
switch, rate-limited to five per ten seconds, and written to the audit log as
`automation.deep_link` with the action and outcome (never the URL).

| URL | Does |
| --- | --- |
| `plainsong://record` | Toggle dictation, exactly like the hotkey's toggle |
| `plainsong://stop` | Stop dictation if it is running; otherwise nothing |
| `plainsong://mode?key=<id>` | Switch the dictation mode: `voice`, `messages`, `email`, `notes`, `meeting_follow_up`, or a saved custom mode's id |
| `plainsong://meeting/start` | Bring Plainsong forward and open the meeting consent sheet |
| `plainsong://meeting/stop` | Stop the running meeting |
| `plainsong://open` | Bring the main window forward |

From a terminal:

```sh
open "plainsong://record"
open "plainsong://mode?key=email"
```

### Raycast

Create a Script Command (`Create Script Command…`), template Bash:

```sh
#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title Plainsong: toggle dictation
# @raycast.mode silent
open "plainsong://record"
```

Duplicate it for `plainsong://meeting/start` and the modes you use.

### Shortcuts

Add an **Open URLs** action with `plainsong://record` (or any URL above) and
give the shortcut a keyboard shortcut or a menu-bar entry. Shortcuts run the
same gate: with Local tools off, the app ignores the link.

### Why the app's own `plainsong://` scheme

`plainsong://bundle/…` is already the renderer's privileged origin inside the
app. Chromium routes every `plainsong:` navigation the renderer could make to
that in-process handler, which answers 404 for any host other than `bundle`,
so a page inside Plainsong cannot reach the OS-level deep-link handler
through its own scheme. A second, unregistered scheme would have been an
external navigation, which is exactly what gets handed to the OS. The deep
link parser refuses the `bundle` host, so the two namespaces never overlap.
