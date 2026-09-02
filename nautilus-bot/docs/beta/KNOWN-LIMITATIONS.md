# Known limitations in Plainsong 0.9.0-beta.2

This is a limited beta for testing, not a 1.0 release. Please report behavior
that falls outside these boundaries instead of working around macOS security or
using sensitive content.

## Evidence boundary for the first invite group

- The exact integration candidate still requires fresh package, trust,
  Dictation, Meetings, accessibility, and updater evidence before distribution.
  Historical candidate receipts are not carried forward.
- Formal current-hash repetitions of the insertion matrix, real-device Meeting
  lifecycle rows, and soak remain required. Report insertion failures,
  source-routing mistakes, long-session drift, or recovery failures immediately.
- Automatic beta updates are not available until the signed updater journey and
  public beta feed pass their release gates. Initial testers receive a verified
  DMG and checksum through the private invitation channel after approval.

## Platform

- Plainsong currently supports Apple Silicon Macs on macOS 13 or later. Intel
  Macs and Windows are outside this beta.
- Native Me + Them system-audio capture requires macOS 14.7 or later. Older
  supported macOS versions require an already configured virtual loopback
  device such as BlackHole, or should use microphone-only Meetings.

## Dictation

- System-wide insertion requires Accessibility permission. Password fields and
  other secure macOS controls intentionally reject automated insertion.
- Some apps may reject direct insertion even after transcription succeeds.
  Plainsong preserves the recognized text and offers copy-based recovery rather
  than discarding it or claiming it was inserted.
- The first local model download and preparation take longer than later
  Dictations and require additional disk space. Ready means the selected model
  is actually present, not merely selected in Settings.

## Meetings

- A Meeting interrupted before its first durable WAV checkpoint may be too
  short to recover. Relaunch reports that state as an error instead of
  promising a retry that cannot succeed.
- Me + Them source labels distinguish microphone-side speech from captured
  system audio. They are not a promise of perfect person-by-person speaker
  identification.
- Never use the beta to record a confidential conversation without the consent
  required by your organization and location.
- Plainsong does not post the consent notice into the meeting chat for you.
  The start sheet shows the notice text and a Copy button; sending it in
  Zoom, Google Meet, or any other meeting is your action, every time.

## Updates and rollback

- The automatic updater accepts only a strictly newer version. Downgrades are
  intentionally blocked because an older build may not understand newer local
  data.
- Update checks and downloads require access to the public Plainsong beta feed.
  Local Dictation and Meeting processing do not require that feed after the
  needed models are installed.

## Diagnostics and remote providers

- The installed beta does not yet expose support-bundle creation in its UI.
  Use the report template and the private invitation channel. Do not send raw
  logs, recordings, transcripts, dictated text, credentials, or Keychain data.
- Cloud speech and analysis providers are optional, use credentials you supply,
  and send the relevant audio or text directly to that provider. Local
  processing remains the default.
