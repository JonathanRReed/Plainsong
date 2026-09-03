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
- "Process again" needs the dictation's audio, and Plainsong keeps that only
  when "Keep dictation audio for Process again" is on, which it is not by
  default. Turning it on affects later dictations, never ones already saved,
  and the kept audio is deleted with its history entry — by auto-delete or by
  hand. A history entry whose audio is gone says so and names the setting
  rather than offering an action it cannot complete.
- History search covers the dictations still in history. Anything auto-delete
  has already removed cannot be found, and dictations saved before this
  version were indexed on their delivered text only, so for them a search
  cannot distinguish what was heard from what was delivered.
- The built-in cleanup model (S1-mini by Superwhisper) is a text normalizer,
  not an assistant. It fixes fillers, punctuation, capitalization and spoken
  numbers/dates, in English only. It cannot write meeting notes, and while it
  is the selected dictation route, custom modes and dictation commands fall
  back to Plainsong's own deterministic text transforms instead of running
  their prompt. Pick Ollama or a cloud provider for those.
- The built-in cleanup model needs the GPU to fit inside the pre-insert
  budget. Measured on an M4 Pro, a 200-word dictation takes 1.8 s on Metal and
  11-13 s on CPU against a 6 s budget, so on a Mac where Metal does not
  initialize a long dictation is inserted unformatted with a warning. The
  shipped macOS build always compiles the Metal backend.
- Apple's on-device cleanup route needs macOS 26 or newer, an
  Apple-Intelligence-eligible Mac, and the feature switched on with its model
  downloaded. Models says which of those is missing. This route has not been
  run end to end in qualification: on the machine that built it, Apple
  Intelligence had not finished downloading its model.
- Numbers as digits (Dictation › Destinations) is English-only and
  deliberately conservative: it converts what it can name a rule for and
  leaves everything else as spoken. It will not turn "two thirty" into a
  time without "at" or am/pm, will not read "twenty twenty six" as a year
  outside a date, keeps a bare "one" and simple ordinals ("first" ..
  "tenth") as words outside a date, and never abbreviates units
  ("25 kilometers", not "25 km"). A month name that is also an ordinary word
  needs a second signal before a day converts, so "on may fifth" is a date
  and "i may second that motion" is not. A number phrase no single rule can
  finish stays entirely as words rather than coming out half-written, so
  "ten to one odds" and "point five" are left alone and a spoken digit run
  is written whole or not at all. Thousands separators are written the way
  the number would be typed — cardinals from 10,000 up, currency from 1,000
  up, years never. Engines that already emit numerals pass through untouched.

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
- "Import audio…" accepts .wav, .mp3, .m4a, .aac, .mp4, .ogg and .flac up to
  2 GB and 4 hours. It uses macOS' own audio converter, so it is macOS only in
  this beta, and a file macOS cannot decode (a DRM-protected purchase, an
  unusual codec, a .webm — macOS cannot read Matroska at all) is refused with
  the converter's own reason. A file whose length macOS will not report is
  refused rather than decoded, because the 4-hour limit cannot be checked
  without it. The file you
  pick is only read: Plainsong copies the decoded audio into its recordings
  folder and never moves, changes or deletes your original. An imported
  meeting has no microphone and system-audio sides, so speaker separation is
  whatever diarization can infer from one mixed track.
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
