# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Email **`security-contact@example.invalid`**. **This is a pre-publication
placeholder, not a working inbox; the maintainer must replace it with an
explicitly monitored address before the repository becomes public.** Once
GitHub private vulnerability reporting is enabled, you may instead use
**"Report a vulnerability"** under Security → Advisories.

Maintainer pre-publication requirement: enable private vulnerability reporting
at the public-repository cutover and verify that the reporting form is available
without repository write access.

Include what you found, how to reproduce it, and the potential impact. You'll
get an acknowledgement as soon as possible, and we'll work with you on a fix and
coordinated disclosure before any public write-up.

## Scope

Plainsong is local-first. The areas most relevant to security:

- **Credential storage** — provider API keys and internal secrets are stored in
  the OS keychain/credential manager, not in plaintext files.
- **The IPC boundary** — the renderer can only invoke an explicit allowlist of
  sidecar commands; the allowlist is checked against the backend in CI.
- **Filesystem access** — backup/restore and export paths are constrained to
  approved application directories.
- **Local data** — recordings, transcripts, and the database live on the user's
  machine. See [PRIVACY.md](./PRIVACY.md) for the full data-flow picture.

## What's not a vulnerability

- The app requires microphone and (for system-wide insertion) Accessibility
  permissions to function — that's by design and prompted for.
- Choosing a bring-your-own-key cloud provider sends audio/text to that provider
  using your key; that's an explicit opt-in, not a leak.
