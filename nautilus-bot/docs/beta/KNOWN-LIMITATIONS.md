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
- Speaker identification ("who said what") has no published accuracy number.
  It groups voices by embedding similarity; it cannot represent two people
  talking at once, and audio it cannot attribute is left without a speaker
  rather than guessed. A measured comparison against a full pyannote pipeline
  is in `artifacts/qa/diarization-speakrs-spike-2026-09-02.md`; that
  alternative backend is a build-time experiment and is not in any build you
  can install.
- Never use the beta to record a confidential conversation without the consent
  required by your organization and location.
- Plainsong does not post the consent notice into the meeting chat for you.
  The start sheet shows the notice text and a Copy button; sending it in
  Zoom, Google Meet, or any other meeting is your action, every time.
- Call detection is a heuristic. Every few seconds Plainsong looks at which
  apps are running and offers to record when a known conferencing app (Zoom,
  Microsoft Teams, Webex, FaceTime, Slack, Discord) has a second sign of a
  call: a call window, or the default microphone being open by another app.
  Google Meet is recognized only as a browser window whose title says Meet,
  which needs Accessibility permission; without it Meet is never offered.
  Zoom's in-call window title is read the same way, so without Accessibility
  Zoom relies on the microphone sign alone. Both title checks look for the
  English words ("Zoom Meeting", "Meet"); a Zoom or browser running in
  another language is detected through the microphone sign only, and its
  window closing is not noticed. Slack and Discord are usually
  running all day, so another app using the microphone can make one of them
  look like a call; the offer can be dismissed and nothing records without
  your click. While hands-free dictation keeps the microphone open, the
  microphone sign is unavailable and only window titles count. Detection
  never starts a recording.
- The two automatic stops are heuristics too. "Stop when the call app
  quits" only applies to a meeting that began while a call was detected, and
  fires when that app quits or its call window closes; the silence stop
  measures room-level loudness over one-second windows and ends the meeting
  only after every captured source has been under that level for the whole
  fuse (15 minutes by default). A very quiet speaker far from the microphone
  can read as silence; a noisy room can keep a meeting alive. Both stops
  save and transcribe the audio exactly as pressing Stop would.
- Pausing a meeting drops the audio for the length of the pause; it is not
  recorded anywhere. The saved file skips the gap and the transcript marks
  where it was. The transcript preview and both silence detectors stand
  still while paused, and the elapsed clock excludes paused time.
- Notifications use macOS Notification Center. The first one Plainsong shows
  is what makes macOS ask whether to allow them; if you decline, none appear
  and the in-app surfaces carry the same information.

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
