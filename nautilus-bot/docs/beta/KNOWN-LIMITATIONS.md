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
- Plainsong's interface is English only, and so is everything the window
  frame around it says. Menus that come from Chromium rather than from
  Plainsong — the right-click menu in a text field, the file picker, the
  spell-check submenu — now appear in English too, even on a Mac set to
  another language; the translations for 54 other languages were 46 MB of a
  product none of them had been translated into.
- Dates, times and sort order still follow your Mac, but by a different route
  than before. Dropping those translations also moved the browser engine's own
  default formatting locale to US English, so Plainsong now reads your Mac's
  Language & Region setting itself and formats every date, time and list order
  with it — including the region half, so English with Region set to Germany
  gets 04/03/2026 and a 24-hour clock. What Plainsong does not read is the
  per-setting customization underneath that pane: if you have overridden the
  date format, first day of week or number separators by hand, Plainsong uses
  your region's defaults rather than your overrides.

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
- Speaker identification ("who said what") has no published accuracy number.
  It groups voices by embedding similarity; it cannot represent two people
  talking at once, and audio it cannot attribute is left without a speaker
  rather than guessed. A measured comparison against a full pyannote pipeline
  is in `artifacts/qa/diarization-speakrs-spike-2026-09-02.md`; that
  alternative backend is a build-time experiment and is not in any build you
  can install.
- The CAM++ speaker model runs without ONNX graph optimization, because the
  ONNX Runtime this build links rewrites part of that model's graph
  incorrectly. Turning the rewrite off is what makes CAM++ match the runtime
  the model was published against; it costs about 5% more time per embedding on
  that model only. Speaker separation is unaffected, and the other three
  speaker models are untouched. The measurement, including what the defect did
  before this was found, is in
  `artifacts/qa/campplus-divergence-2026-09-02.md`.
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
- Speaker labels from a cloud provider only cover a whole meeting when the
  whole meeting fit in one request. Deepgram and Gemini are the only providers
  here that return speakers, and each numbers them per request — "speaker 0" in
  one request is not promised to be the same person as "speaker 0" in the next.
  Plainsong sends the whole recording in one request where the provider allows
  it (Deepgram up to two hours, Gemini up to thirty minutes). The Gemini
  figure is Google's own cap for a diarized request; the Deepgram one is
  Plainsong's, because Deepgram publishes no duration limit -- only a 2 GB
  request size, which two hours of a meeting recording stays well inside. Past that, or when the single request fails,
  the meeting is transcribed in ninety-second chunks and Plainsong's own
  diarizer labels the speakers instead. The meeting header always names which
  one ran; it is never inferred from the transcription provider.
- Plainsong's own diarizer separates voices with fixed two-second windows and
  no overlap handling, so simultaneous speech and rapid turn-taking are where
  it loses. It is the only option for a locally transcribed meeting: no local
  speech model returns speaker labels.
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
- Remembered voices (Settings > General > Meetings) are off by default, and
  what they can do is bounded in ways worth knowing before you turn them on.
  The thresholds that decide whether two voices match were calibrated on
  synthetic speech — six macOS `say` voices, six utterances each, no room, no
  microphone, no crosstalk (the numbers are in
  `artifacts/qa/voiceprint-calibration-2026-09-02.md`). Real meetings are
  harder than that in every direction, so the measured accuracy is an upper
  bound, not a promise about your Mac. Matching also assumes one voice per
  speaker turn: where two people share a microphone, or talk over each other,
  the signature Plainsong stores describes neither of them well. A voice
  remembered under one speaker-separation model is never compared with
  another, so changing the model in Settings > Transcription means later
  meetings start over rather than matching against numbers from a different
  system — the old voices are kept, not deleted, and become live again if you
  change back. Nothing is matched from a calendar or an attendee list: a
  suggestion always comes from the audio, and where a meeting has attendees
  they only decide which of several suggestions is shown first, never which
  voice matched. Suggestions for speakers you never named do not survive
  quitting Plainsong: the signature behind them is only written once a speaker
  has a name, so until then it is held in memory and goes when the app does.
  Reopening such a meeting later shows the transcript exactly as it was, with
  no chips, until you run speaker identification again. And a suggestion is an
  offer —
  Plainsong applies a name on its own only if you also turn on "Apply a
  confident match without asking", and even then the transcript marks that
  name "auto" until you confirm it, and a name you typed is never overwritten.
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
