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
