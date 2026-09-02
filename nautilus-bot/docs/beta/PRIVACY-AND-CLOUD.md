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

Addresses are visible to you on hover in the meeting header, are included in a
meeting export the same way the rest of the meeting is, and are deleted with
the meeting.

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
