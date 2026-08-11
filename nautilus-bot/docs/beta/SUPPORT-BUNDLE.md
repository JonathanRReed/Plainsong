# Privacy-safe support bundles

Plainsong's support bundle is a previewable JSON file. It includes app and OS
versions, boolean readiness states, safe configuration identifiers, and file
counts. It deliberately excludes content.

## Installed-app testers

The first limited beta does not expose the support-bundle generator inside the
installed app. Do not install Bun, clone the repository, or send raw logs just
to file a report. Complete [ISSUE-TEMPLATE.md](ISSUE-TEMPLATE.md) without a
bundle. If additional diagnostics are necessary, the beta owner will arrange a
maintainer-assisted session.

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
