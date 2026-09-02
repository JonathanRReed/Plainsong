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

## The meeting consent notice

Before a Meeting starts, Plainsong shows a short notice you can copy that
tells participants the meeting is being recorded and transcribed. Plainsong
does not post that notice into Zoom, Google Meet, or any other meeting chat on
your behalf, and it does not type into or press keys in another app to do so.
Sending the notice is your action. Plainsong records only whether the consent
sheet was shown for that meeting.

## Permissions

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
