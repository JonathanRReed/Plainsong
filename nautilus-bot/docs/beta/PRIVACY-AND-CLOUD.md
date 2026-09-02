# Privacy and cloud processing in the beta

Plainsong is local-first. By default, Dictation and Meeting transcription run
on your Mac. There is no Plainsong account, telemetry service, crash collector,
analytics SDK, or Plainsong-operated audio relay.

## What stays local by default

- temporary Dictation audio, which is removed after processing
- Dictation history and corrections
- Meeting audio according to your chosen storage and retention settings
- transcripts, notes, summaries, action items, and follow-up drafts
- local model inference and optional Ollama analysis
- settings and database content

API keys and internal secrets are stored through the macOS Keychain, not in the
support bundle or plaintext settings.

## The vault and database encryption

Turning the vault on in Settings > Privacy generates a database key, stores it
in the macOS Keychain, and encrypts `plainsong.db` with SQLCipher. Meeting
audio bundles are encrypted separately with a key derived from your vault
password.

**Correction for anyone who turned the vault on before 0.9.0-beta.3:** the
database encryption step did not encrypt the database. The key was generated
and stored correctly, and the app reported "database encrypted", but the
operation used to perform the encryption is a no-op on a database that was
never keyed, so the file stayed readable by anything that could open it. Audio
bundle encryption and Keychain storage were not affected.

This build detects that state at launch — a key in the Keychain, a plaintext
database — and performs the real migration: it exports the database into a new
encrypted file, verifies that the new file opens with the key and does not open
without it, and atomically replaces the original. Nothing is lost, and the app
tells you it happened. If the migration cannot finish, the app keeps working on
the plaintext database, says so, and reports the database as not encrypted
rather than claiming otherwise.

One thing the migration cannot do: the pages of the old plaintext file are
unlinked, not overwritten, so until the volume reuses those blocks the
pre-migration contents remain recoverable by forensic tools. On a Mac with
FileVault on they are still covered by full-disk encryption.

## Network activity without remote speech processing

- downloading a model from its named upstream host
- checking the public beta update manifest when you request an update
- downloading a beta update after you approve it
- using your own configured backup destination

These requests expose normal network metadata, such as your IP address, to the
service you contact. They do not include your audio or transcript unless you
explicitly enable a remote speech or analysis provider.

## Remote processing is opt-in

If you enable a cloud transcription or analysis provider, Plainsong sends the
relevant audio or text directly from your Mac to that provider using your own
credential. The provider's terms and privacy policy then apply. Plainsong does
not proxy the request.

Turning remote processing off revokes that authorization for new work. In-flight
remote requests are cancelled and a result returned after revocation is not
committed as an accepted local result.

## Call detection and notifications

When "Offer to record a call it notices" is on (the default), the local
sidecar reads the list of running applications on this Mac every few seconds
and keeps only the bundle identifiers of known conferencing apps and
browsers, and asks CoreAudio whether the default microphone is open by
another process. CoreAudio answers that question without any permission and
without naming the process.

**What window titles are read.** Only with Accessibility permission, and
only where a title decides something:

- Zoom's window titles, every poll, to tell an in-call window ("Zoom
  Meeting") from the home window.
- A browser's window titles, but only when the microphone is already open by
  another process, or when that browser is where the call currently being
  offered was found. Without one of those reasons Plainsong does not ask a
  browser for its windows at all — partly for your privacy, partly because
  asking a Chromium browser switches it into full accessibility mode for the
  rest of its life.

**What is kept, and what leaves the sidecar.** Nothing about which apps you
run is written to disk or sent anywhere, and nothing is kept beyond the
current poll except the one call currently being offered, which is held in
memory until it ends. A window title is used to answer one question — is
this window still open — and is never included in the notification, in the
in-app cue, or in the event the sidecar sends to the app's windows. That
event carries the app (Zoom, Google Meet), its bundle identifier, when the
call was noticed, and whether a window was involved at all; a Google Meet
tab's title is the meeting's own name, and it stays in the sidecar. Turning
the setting off stops the polling within a few seconds.

macOS notifications carry the app name and the meeting's state (started,
stopped, transcript ready, notes ready or failed) or a one-line reason a
dictation was not delivered. They never contain transcript text, notes, or
dictated words.

## The meeting consent notice

Before a Meeting starts, Plainsong shows a short notice you can copy that
tells participants the meeting is being recorded and transcribed. Plainsong
does not post that notice into Zoom, Google Meet, or any other meeting chat on
your behalf, and it does not type into or press keys in another app to do so.
Sending the notice is your action. Plainsong records only whether the consent
sheet was shown for that meeting.

## The calendar, and who was in a meeting

Calendar access is optional and never asked for at launch: the prompt follows
the "Connect calendar" button and only that button. Plainsong reads the next
few hours of events, never writes to a calendar, and sends nothing anywhere by
reading one.

What the calendar helper emits is deliberately narrow. Event titles and times
leave it whole. Locations and notes do not: they are run through a link
detector inside the helper and only http/https matches escape it, so a note
reading "budget review with Dana at 40 Hill St" contributes a Zoom link and
nothing else.

Attendees are the exception, and they are the feature. When you start a
meeting from a calendar cue, Plainsong stores the invitee list on that
meeting: each person's display name, and their email address when the calendar
had one. You can add or remove attendees by hand on any meeting. The list is
stored in the local database beside the rest of the meeting.

Two limits on where that list can go:

- **Names, never addresses, reach an AI provider.** When a meeting has
  attendees, its summary and chat prompts carry a single `Attendees: ...` line
  of names, inside the same fenced, non-instruction data block the notes use.
  Email addresses are dropped before the prompt is built and are never sent to
  a local or cloud analysis provider. They exist to recognize the same person
  across two meetings and to label a chip, and that is all.
- **Nothing about a calendar leaves your Mac on its own.** The attendee names
  travel only where the meeting's own transcript already travels: to the AI
  provider you chose, at the moment you ask for a summary or an answer.

Addresses are visible to you on hover in the meeting header, are written into
a meeting export (Markdown, Word, plain text and JSON) beside the names, and
are deleted with the meeting. An export is a file on your own disk, which is
why it is the one place the whole list goes. The local `plainsong` CLI and its
MCP server are not: `get_meeting` returns attendee NAMES only, framed as
untrusted content like every other field somebody else wrote.

The pre-meeting brief follows the same rule. "Prepare" on a calendar cue
searches only meetings already on this Mac — ones sharing an attendee or a
meeting name — and sends their summaries, decisions and open items, plus the
upcoming meeting's name and the invitees' NAMES, to the analysis provider you
chose. No addresses, no calendar beyond that one event, and nothing fetched
from anywhere. With no analysis provider configured, nothing is sent at all
and the panel shows the related meetings it found locally.

## Permissions

- Calendar is optional and only used to offer to start capture for a meeting
  you are about to join, and to record who was invited to it.
- Microphone is required for Dictation and mic-side Meeting capture.
- Accessibility is required to insert Dictation into other apps.
- Speech Recognition is optional and only used by the Apple on-device
  Dictation route.
- Screen and System Audio Recording is optional and only used when you choose
  Me + Them Meeting capture.

You can revoke permissions at any time in System Settings. Plainsong will show
the affected primary action as unavailable and provide a repair action rather
than pretending the feature is ready.

See the repository-level `PRIVACY.md` for the full data contract.
