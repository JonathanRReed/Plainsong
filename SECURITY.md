# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Email **Contact@JonathanRReed.com**. Once GitHub private vulnerability
reporting is enabled on this repository, you may instead use **"Report a
vulnerability"** under Security → Advisories.

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
- **Model integrity** — every local model file is checked against a SHA-256
  pinned in the app before it is used. See the threat model below.

## Model integrity threat model

Plainsong writes nothing to disk about which model files it has checked.
Each time the app starts, it trusts no model file until that run of the app
has read the whole file and matched it against the SHA-256 pinned in the app.
Starting the app reads no model bytes. A file is hashed the first time the
app needs it: when it loads for dictation, a meeting, notes or search, or right
after it downloads. Shortly after launch, a low-priority background pass also
checks the speech models that the current dictation and meeting settings use,
so the first dictation usually does not wait for a hash.

The app hashes a file through the same open file handle that the loader then
reads. Where a library has to open the file by name, the app hands it a path
that names that exact file (on macOS, `/.vol/<device>/<inode>`), not the
original path, and keeps its own handle open until loading finishes. While
the app runs, it remembers each match in memory along with the file's device,
inode, size, and modification and change times. Before each later load it
compares those values with an `fstat` of the new handle. If any of them
differs, the app hashes the file again. If a load fails, or the file changes
while it loads, the app forgets that file and checks it again next time. When
a file does not match its pin, the model shows as not installed and the app
asks you to download it again.

Helper processes get the same protection in one of two ways. The built-in
text model helper receives the checked file handle and reads only that. The
search helper hashes the bytes it actually maps against the same pins, and
it refuses a file that does not match. It does not rely on a check the app
made. It hashes each file once per indexing run.

Plainsong also deletes `verified-models.json`, a file some development builds
wrote, without reading it.

This protects against corruption and swapped files: a partial copy, a disk
error, a sync tool, or a different file dropped in. It does not protect
against malware running as your user account. Code that can replace a model
file can also change the app's settings or the app itself. Not storing any
record means there is nothing on disk for such code to forge, and it keeps
the Keychain out of startup.

Two kinds of code do not load model files through a checked handle. The
first is test-only code, such as parity checks, model probes and evaluation
tools, which are not part of the app. The second is Apple's Core ML, which opens the Neural Engine speech
model folder by path in a separate helper. For Core ML the app hashes every
file first and keeps them open. After the helper loads them, the app confirms
that each path still names the file it checked. A swap that is undone before
that confirmation is not caught.

## What's not a vulnerability

- The app requires microphone and (for system-wide insertion) Accessibility
  permissions to function — that's by design and prompted for.
- Choosing a bring-your-own-key cloud provider sends audio/text to that provider
  using your key; that's an explicit opt-in, not a leak.
