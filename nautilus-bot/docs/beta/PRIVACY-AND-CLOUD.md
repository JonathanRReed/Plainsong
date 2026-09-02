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
