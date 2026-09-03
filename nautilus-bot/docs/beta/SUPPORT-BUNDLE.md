# Privacy-safe support bundles

Plainsong's support bundle is a previewable JSON file. It includes app and OS
versions, boolean readiness states, safe configuration identifiers, and file
counts. It deliberately excludes content.

## Installed-app testers

Settings -> Privacy & Security -> Diagnostics -> **Create support bundle...**

"Show what is included" lists the files, the redaction rules, and what the
bundle never carries, before anything is written. The button then opens a save
dialog; Plainsong writes a zip where you choose and nowhere else. Nothing is
uploaded, and no path is ever named by the app's window -- the sidecar only
ever sees the file you picked.

Every file the zip holds is listed in the app before it is written, and again
in the zip's own `README.txt`:

| File | What it holds |
| --- | --- |
| `README.txt` | this list and the redaction rules, in prose |
| `manifest.json` | the same list as JSON, plus the time the bundle was made |
| `summary.json` | app version, macOS version, chip, core count, memory |
| `settings-redacted.json` | your settings, reduced to switches, numbers, and short names |
| `readiness.json` | which macOS permissions Plainsong currently has |
| `models.json` | which model files are on disk, their sizes, and their integrity-receipt status |
| `audit-log-tail.json` | recent audit events, with details redacted |
| `logs-redacted.txt` | the tail of this session's app and sidecar logs |
| `build-identity.json` | app, Electron, Chrome, and Node versions, and whether the build is packaged |

The log section is in-memory and per-session: relaunching the app empties it,
so make the bundle in the session where the problem happened. Plainsong does
not embed a signed release receipt in the app bundle, so `build-identity.json`
reports the versions the running process knows rather than a signed receipt.

If any redaction rule fails to remove a home path or an email address, the app
refuses to write the file at all and says so. Read the zip before you send it.

## Source-checkout testers

From the repository checkout, run:

```bash
cd nautilus-bot
bun run qa:support-bundle -- \
  --settings "$HOME/Library/Application Support/Plainsong/settings.json" \
  --inventory-root "$HOME/Library/Application Support/Plainsong" \
  --out "$HOME/Desktop/plainsong-support-bundle.json"
```

The command exits successfully only when the generated file passes its built-in
path and source checks. Open the JSON in TextEdit and review it before sharing.

The bundle excludes audio, filenames, dictated text, transcripts, Meeting
titles and notes, custom prompts, dictionary entries, snippets, clipboard and
selected text, log bodies, credentials, tokens, cookies, Keychain data,
hostnames, account names, and full filesystem paths.

Send the JSON through the private invitation channel. If `safeToShare` is
`false`, do not send it. Report the listed error without attaching the file.
