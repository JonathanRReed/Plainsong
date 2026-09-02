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

- System-wide insertion requires Accessibility permission.
- Plainsong checks the focused control before every insertion. When it is a
  password box or another secure input (macOS reports the `AXSecureTextField`
  role or subrole, or secure keyboard entry is on), Plainsong does not insert,
  does not stage the words on the clipboard, and does not send the Cmd+C used
  to read a selection. The words stay in dictation history with the usual Copy
  action, and the popup says why. This covers the clipboard-only insertion
  mode too. Two caveats: macOS's secure-keyboard-entry flag is system-wide
  (Terminal's Secure Keyboard Entry keeps it on while Terminal runs), so
  Plainsong lets that flag decide only when it cannot inspect the focused
  control — without Accessibility permission, or when no focused element is
  reported — and with Accessibility granted an ordinary field in another app
  still takes dictation while Terminal has secure entry on. And the check is
  macOS-only — Windows insertion has no equivalent probe yet.
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
- Local meeting routes: Parakeet TDT 0.6B v3 (25 European languages) is the
  recommended route. For a language it does not cover, the multilingual
  whisper.cpp models small, medium, large-v3 and large-v3-turbo can run
  meetings (about 100 languages, on the GPU, slower than Parakeet on long
  audio). whisper.cpp tiny, base and every `.en` build stay dictation-only, and
  whisper.cpp is never chosen for meetings on its own: it runs a meeting only
  when you pick one of those models for the meeting lane in Settings.
- "Import audio…" accepts .wav, .mp3, .m4a, .aac, .mp4, .webm, .ogg and .flac
  up to 2 GB and 4 hours. It uses macOS' own audio converter, so it is macOS
  only in this beta, and a file macOS cannot decode (a DRM-protected purchase,
  an unusual codec) is refused with the converter's own reason. The file you
  pick is only read: Plainsong copies the decoded audio into its recordings
  folder and never moves, changes or deletes your original. An imported
  meeting has no microphone and system-audio sides, so speaker separation is
  whatever diarization can infer from one mixed track.
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
