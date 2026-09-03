# Changelog

All notable changes to Plainsong are documented in this file.

## [Unreleased] - 0.9.0-beta.3 (in progress)

Two audited fix waves merged on top of the `0.9.0-beta.2` integration
candidate: Electron security hardening, meeting data-integrity fixes, model
currency, sidecar robustness, and a renderer UX pass on Dictation and
Meetings recovery. `package.json` has not been bumped and no `0.9.0-beta.3`
package has been built; this section is a source-level record of what
changed underneath `0.9.0-beta.2`. See `LAUNCH.md` for which qualification
evidence is stale and must be recaptured before this becomes a candidate.

### Added
- The dictation live preview can be drawn by a real streaming recognizer
  instead of by re-transcribing. Until now the popup's live text was a batch
  re-decode of everything you had said so far, run again every few hundred
  milliseconds, so the words landed a whole decode behind you. With the new
  live preview engine installed — a 716 MB download on the Models screen,
  experimental, off unless you fetch it — the recognizer keeps what it has
  already heard, and the popup shows the words it has settled on apart from
  the tail it may still change. **What Plainsong types is unchanged**: the
  inserted text is still the finished transcription from your dictation
  engine, made after you stop. Without the download, or in a language the
  engine's own model file does not declare, the previous preview runs exactly
  as before. Settings gains "What draws the live preview" (whichever is
  available / streaming / re-transcribe) under the existing Live preview
  control.
- Dictation history is searchable, and a saved dictation can be run through
  the recognizer again. The search field over Recent dictations matches both
  what was delivered and (where it was kept) what the recognizer heard,
  marking the matched words in each result. "Process again" in a saved
  dictation's dialog re-runs its kept audio through any style and saves the
  result as a new history entry linked to the original — it never types or
  pastes anything. Keeping the audio is a new off-by-default setting, "Keep
  dictation audio for Process again"; without it, the dialog says so and
  names the setting instead of offering a button it cannot honour. Kept audio
  is deleted with its history entry, and with the vault on it is encrypted
  into the vault like a meeting's audio rather than left in the clear.
- "Import audio…" in the Meetings header transcribes an audio file you
  already have. Plainsong decodes .wav, .mp3, .m4a, .aac, .mp4, .ogg and
  .flac up to 2 GB and 4 hours with macOS' own converter, copies the
  result into its recordings folder, and runs the same transcription,
  diarization and analysis a stopped meeting runs, reporting the same
  progress. The file you picked is only ever read — never moved, changed or
  deleted. Imported meetings are labelled "Imported file" rather than
  Me + Them, name the file they came from, and skip the consent step, which
  has nothing to describe when nobody is being recorded. A file whose length
  macOS will not report is refused rather than decoded, decoding gives up
  rather than hanging on a source that stops answering, and a volume without
  room for the decoded copy is told so before anything is written.
- Multilingual meetings can use whisper.cpp. The `small`, `medium`,
  `large-v3` and `large-v3-turbo` ggml models are now allowed in the meeting
  lane, so a language outside Parakeet v3's 25 European languages has a local
  meeting route that is not the experimental CPU-bound Qwen3 (100 languages,
  runs on the GPU, slower than Parakeet). `tiny`, `base` and every `.en`
  build stay dictation-only, Parakeet stays ranked first in every policy, and
  whisper.cpp never enters the meeting lane on its own: a `base.en` default
  still resolves meetings to Parakeet, and whisper runs a meeting only when
  one of those four models is picked for the meeting lane.
- A local pre-meeting brief. "Prepare" on a calendar cue reads meetings
  already on this Mac that share an attendee or a normalized meeting name with
  the one you are about to join, and writes a short brief — what was last
  agreed, what is still open, what you owe anyone — citing the meetings it
  came from. Related meetings are found and ranked locally; the only thing
  that leaves the Mac is the prompt, down whichever AI lane you already chose
  for meetings. With no analysis provider configured it shows the related
  meetings and their open items instead of an error. Cached per event and
  input, with a "Refresh".
- Meetings started from a calendar cue now record who was invited. The macOS
  calendar helper reports each attendee's name (and the address the calendar
  had for them, when it had one); the meeting header shows them as chips with
  the address on hover, and any meeting can have attendees added or removed by
  hand. Renaming a speaker offers those names. When a meeting has attendees,
  its summary and chat prompts carry one `Attendees: ...` line of NAMES only,
  inside the same fenced non-instruction block the notes use — addresses are
  never sent to an AI provider. Locations and notes are still stripped inside
  the helper exactly as before. See `docs/beta/PRIVACY-AND-CLOUD.md`.
- Saved prompts for the two chat boxes. Type "/" in a meeting's chat or in
  "Ask your meetings" to pick a question you keep asking; "Save as prompt" on
  a message you already sent turns it into one. Six starters ship (decisions,
  open questions, what you committed to, risks and blockers, a follow-up
  draft, a catch-up explanation); they can be edited, reordered and hidden,
  but not deleted, because they would only come back. Manage them from
  Settings → AI or the picker's own footer. They live in your settings file
  on this Mac and choosing one only fills the box.
- A meeting export now says who was there. Markdown, Word, plain text and
  JSON carry the attendee list with names and addresses — an export is your
  own file — while the local `plainsong` CLI and MCP server return attendee
  names only. Prompts are unchanged: still names, never addresses.
- Dictation writes spoken numbers the way they read: "twelve dollars fifty"
  becomes $12.50, "march third at three thirty pm" becomes March 3 at
  3:30 pm, "one hundred twenty three" becomes 123, and a run of spoken
  digits becomes a phone number. It runs locally, after voice commands and
  before phrase expansions, and never rewrites inside a dictionary
  correction, a phrase expansion, or a URL or email address. Anything
  ambiguous is left as you said it — "one of them", "a couple of",
  "two thirty" without a time, "give me a second". On by default for
  Slack & Chat, Writing, Notes and Meeting Follow-up; off for the General
  profile, which keeps your words as spoken. Per-profile switches in
  Dictation › Destinations.
- Plainsong now notices a live call and offers to record it. Every few
  seconds the sidecar checks, locally, which apps are running; when Zoom,
  Microsoft Teams, Webex, FaceTime, Slack, Discord, or a browser window
  titled for Google Meet (Accessibility permission needed) has a second sign
  of a call — its call window, or the microphone open by another app — a
  macOS notification asks "Zoom call started. Record it with Plainsong?" and
  the Meetings header shows the same offer beside the calendar cue. Clicking
  either opens the usual consent sheet with the title prefilled ("Zoom call,
  14:05"); nothing records without that click, and dismissing is per call.
  Off switch and copy in Settings › General › Meetings.
- A meeting recorded alongside a detected call stops on its own when that
  app quits or its call window closes, and any meeting stops after 15
  minutes with nothing audible on every captured source (Settings › General
  › Meetings; 0 turns the silence stop off). Both go through the normal stop
  path, so the audio is saved, hashed and transcribed, and a notification
  says why ("Meeting stopped: Zoom closed").
- Pause and resume a meeting from the recording mini window, the Meetings
  header, or the live meeting card (⌘⇧P). The microphone and system audio
  stay open, so resume is instant, but nothing captured while paused reaches
  the file, the live preview, or the silence watchdogs; the clock stands
  still, the saved audio skips the gap, and the transcript timeline marks it
  as "[Paused 2 min 10 s]". Pauses are recorded on the meeting and in the
  audit log.
- macOS notifications for meeting events (started, stopped, stopped on its
  own, transcript ready, notes ready or failed) and for a dictation that was
  refused or could not be delivered while the dictation mini window is
  hidden. One sentence each; clicking one opens the meeting or the dictation
  view. Both classes have a switch in Settings › General › Notifications.
- A local command-line tool, a read-only MCP server, and `plainsong://` deep
  links, all behind one off-by-default switch (Settings > General > Local
  tools). `plainsong list / search / show / transcript / export / dictations
  / stats` read the same SQLCipher database the app uses, opened with
  SQLite's read-only flag from a separate `plainsong-cli` binary packaged
  beside the sidecar; there is no write command. `plainsong mcp` serves six
  read-only tools over stdio to Claude Desktop, Claude Code or Cursor,
  answers both the 2025 `initialize` handshake and the 2026-07-28
  per-request protocol, caps and paginates results, and wraps every
  transcript, note, summary, action item and dictation string in an
  `<untrusted_content>` frame whose close tag cannot be forged from inside.
  `plainsong://record`, `stop`, `mode?key=…`, `meeting/start` (opens the
  consent sheet, never records), `meeting/stop` and `open` are the only
  links; they carry no text, are rate-limited, and are written to the audit
  log by action and outcome. "Install command-line tool" in Settings links
  `/usr/local/bin/plainsong` or, when that directory is not writable, shows
  the one command to paste rather than asking for an administrator
  password. Deep links are registered with macOS, so a web page can trigger
  one exactly as a script can, and macOS does not say which app sent it; the
  switch and the doc say so, and a link that starts dictation shows the
  dictation window with "Recording from a link" on it. The packaged
  `plainsong-cli` is signed with an empty entitlement set, and the packaging
  gate now checks that. See docs/automation.md.
- Exports can now be written as subtitles or as a Word document. "Subtitles
  (SRT)" and "Subtitles (WebVTT)" build cues from the transcript's timed
  segments — lines wrapped at 42 characters over at most two lines, speaker
  aliases as the cue prefix, and sub-half-second segments folded into the
  neighbouring turn so a cue is readable before it goes. "Word document
  (.docx)" writes the Markdown export as a real Office package (headings,
  bullets, numbered lists, bold), and there is a matching "Meeting Notes
  (Word)" export template. The chosen redaction level applies to all of them,
  because every format is redacted as text before the file is encoded; a
  .docx preview shows the Markdown the document is built from and says so.
  Asking for subtitles on a recording that has no transcript says that
  instead of writing an empty file.
- Action-item owners and due dates are now shown as their own chips beside the
  task in the meeting workspace, instead of being left inside the sentence as
  "(Owner: … · Due: …)", and the JSON export carries each item split into
  task, owner, and due date alongside the verbatim line. Plainsong only fills
  an owner it can point at: the model is told to set one solely from a line it
  cites, and an owner that neither the cited lines nor a speaker alias names
  is dropped while the task itself is kept.
- Meetings now play their own audio in the app, in step with the transcript:
  play/pause, a scrubber drawn over the stored waveform, 1×/1.5×/2× speed,
  ← → to skip five seconds, and Space to play or pause with the transcript
  focused. Clicking a transcript line seeks the audio there, the line under
  the playhead carries the gold reading mark, and the transcript follows
  playback unless you scrolled it yourself in the last few seconds. A
  vault-encrypted recording is decrypted frame by frame into an app-owned,
  owner-only temporary file that is deleted when you leave the meeting, when
  the vault locks, and at every sidecar start and stop; the renderer never
  receives a file path, only a single-use token that the privileged
  `plainsong://playback` route resolves per request (with HTTP Range support,
  so seeking does not wait on a full download). "Open audio file", which
  hands the recording to the system player, stays as the secondary action.
- **More than one dictation shortcut.** Settings → Shortcuts now holds a list
  of dictation bindings instead of a single hotkey. A binding can be a key
  chord, an extra mouse button (3–5), or a modifier on its own (Fn, Cmd), and
  it can start dictation in the current profile, start it in one named
  profile for that session only, move to the next profile, or cancel. Each
  binding chooses hold-to-talk or press-to-toggle, or follows the activation
  setting. Mouse buttons and lone modifiers need the native shortcut helper
  and say so in the row when it is not running; key bindings still fall back
  to Electron's press-only registration, where hold degrades to toggle as
  before. Existing settings migrate: the old `toggleDictation` key becomes
  the first binding and is kept written for one release so a downgrade still
  has a hotkey.
- **Translate to English, per profile.** A dictation profile (and the
  built-in profiles as a group) can now deliver English whatever language was
  spoken. Multilingual whisper.cpp models translate inside their own decode
  with nothing else running; every other recognizer transcribes in the spoken
  language and the dictation AI provider translates before formatting and
  insert, inside the same timeout the formatting pass gets. A translation
  that fails or times out inserts the words as spoken and says so rather than
  losing them. The switch is disabled with the reason when the model cannot
  translate (`.en` whisper builds) or when no AI provider can answer. The
  language the recognizer detected, the route, and whether the translation
  actually landed are recorded in the dictation history details.
- Onboarding now asks how meeting notes get written: local Ollama (with live
  detection), bring-your-own-key cloud AI, or transcripts only — instead of
  silently defaulting to an Ollama install that usually isn't there.
- Meeting recovery actions that did not exist before: "Re-check audio" on a
  meeting whose audio state looks wrong, "Re-transcribe" plus an explicit
  acknowledge step on an incomplete transcript before its audio can be
  cleaned up, and a "Retry" action on a meeting whose summary/action items
  failed to generate.
- Mid-meeting warnings for a dead WAV writer and a filling disk: new meetings
  are refused up front on a volume without enough free space, a low-space
  warning fires while there's still time to act, and a critical-space
  threshold stops the meeting cleanly instead of writing a truncated file.
- A dictation session left running unattended now auto-stops after 10
  minutes with a truncation warning instead of growing its capture buffer
  without bound.
- An explicit, off-by-default "Also copy every dictation to the clipboard"
  toggle in Settings, with the plain-language caveat that turning it on
  replaces clipboard contents on every dictation and does not restore them.
- Qwen3-ASR 0.6B (int4 ONNX, ~1.9 GiB) is now selectable as an
  experimental local route for dictation and meetings, the only local
  route here to Chinese, Japanese and Korean (30 languages listed
  upstream). It had shipped downloadable but gated off because it was
  never run on real audio; the first run found the mel layout transposed
  and the chat-template prompt missing, both fixed. Validated on English
  real audio (3.7% WER on the 44 s fixture against a Parakeet/whisper
  cross-checked reference). It is not promoted and not the default: the
  int4 decoders run on the CPU at anywhere from a quarter of real time to
  slower than real time depending on load (11-59 s for 44 s of speech on
  an M4 Pro across quiet and shared-CPU runs; provisional), and the route's
  own copy says so. Audio longer than 60 s is decoded in pause-aligned
  chunks, and a decode that would come back truncated is refused.

- **Dictation cleanup now works out of the box.** Smart Format used to need
  Ollama installed or a cloud key pasted, so on a fresh install it simply
  never ran. A new "Built-in (no setup)" route downloads S1-mini by
  Superwhisper once (473 MiB, verified against a checksum pinned in the app)
  and then runs it inside Plainsong with no server, no account and no
  network. It removes fillers, resolves false starts, punctuates, and writes
  spoken numbers, dates and email addresses in written form — English only.
  It is the default for the dictation lane on new installs; anyone who
  already chose Ollama or a cloud provider keeps that choice. Models shows
  its size and a Delete action.
  It is deliberately not offered for meeting notes: it is a text normalizer,
  not an assistant, and its own model card says it will not follow general
  instructions. Custom modes and dictation commands fall back to
  Plainsong's built-in text transforms while this route is selected, and
  the picker says so.
- **Apple's on-device model is selectable for dictation cleanup on macOS 26
  and newer.** Nothing to download: it uses the model Apple Intelligence
  already ships, through a small Plainsong helper with no network client and
  no entitlements. Availability is probed at launch and the Models screen
  says which of "this Mac can't", "Apple Intelligence is off" and "it is
  still downloading" applies, rather than only "not available". Also
  dictation-only — its 4,096-token window is shared between the prompt and
  the answer.

### Changed
- Searching dictation history no longer writes an audit-log row. It is a read
  that changes nothing, and the search field re-runs on a debounce and again
  whenever the recordings list changes, so a minute of typing buried the rows
  that record an actual change. "Process again", deletion and retention still
  write theirs.
- **The macOS sidecar now ships Candle's Metal backend** (`candle-metal`),
  so the Distil-Whisper and Whisper large-v3-turbo providers run on the GPU
  instead of CPU F32. Measured on an M4 Pro with a combined
  `candle-metal,ort-coreml` dev binary on a loaded shared machine (two usable
  processes): distil-large-v3.5 went from 32.8 s to 0.96 s p50 for a 5.3 s
  utterance; the as-shipped binary itself was not re-measured (a keychain
  prompt blocked it) and a quiet-machine re-run is still owed, so treat the
  figures as provisional. `scripts/sidecar-cargo-features.mjs` is now
  the one list of macOS-only sidecar features, shared by the release build,
  `lint:rust` / `test:rust` / `benchmark:latency`, CI, and the third-party
  notices. The `ort-coreml` CoreML execution provider was measured as well
  and deliberately left out: it regressed Moonshine (24 s first-load
  compile, slower steady state). Receipt:
  `artifacts/qa/acceleration-receipt-2026-09-01.md`.
- The personal dictionary now reaches the recognizer, not only the text
  afterwards. Each dictation builds a vocabulary hint from the dictionary
  entries and plain-word snippet triggers that apply to the app in front
  (same app/category scoping as the replacement pass; newest first; deduped;
  capped at 60 terms / 600 characters; nothing sent when nothing applies) and
  hands it to the provider with the audio: whisper.cpp as the initial prompt,
  OpenAI and Groq as the `prompt` field (both as one framed sentence,
  `Vocabulary: term, term.` — a bare comma list measurably hurt `base.en` on
  the repo fixtures), ElevenLabs Scribe as `keyterms`.
  Snippet expansions and misheard spoken forms are never sent; the prompt
  is capped at an estimated 200 tokens under whisper's window, withheld on
  near-silent or sub-half-second audio, and an output that only echoes the
  hint on quiet or sub-second audio is decoded again without the prompt
  rather than typed as-is. Cohere's
  OpenAI-compatible endpoint documents `prompt` as unsupported, and Parakeet,
  Moonshine, Candle, Qwen3 and Apple Speech have no equivalent, so those
  routes are unchanged. Note for ElevenLabs users: ElevenLabs bills a 20%
  surcharge on any request that carries keyterms, so a non-empty dictionary
  now costs 20% more per Scribe dictation. `benchmark-latency` gained
  `--vocabulary` so the effect can be measured on the fixtures.
- **Parakeet TDT 0.6B v3 is now the default and recommended dictation
  model** (640 MB), because this repo's own benchmark shows whisper.cpp
  `base.en` mis-transcribing words it hasn't seen before — including
  "Plainsong" itself. Whisper `base.en` (142 MB) remains available as the
  smaller-download alternative in first-run setup, and installs that already
  had `base.en` configured keep it and keep getting its background
  auto-download; nothing forces a re-download. The meeting lane's default is
  unchanged.
- **Meeting capture no longer depends on having an AI route configured.**
  Recording, transcript, and playback are judged on capture alone; a missing
  or unconfigured AI provider (e.g. Ollama not installed) now only degrades
  the notes/summary messaging, quietly, instead of disabling "New meeting,"
  the consent dialog, and the dashboard quick action the way it did when
  capture and AI-notes readiness were the same check.
- **Dictation profile tiles no longer silently turn on clipboard copying.**
  Every built-in mode and recommended app style previously set
  `copyToClipboard: true` on selection, which permanently overwrote whatever
  the user had copied on every subsequent dictation. Clipboard copying is
  off by default now and is only ever changed by the explicit toggle above.
- **The dictation language picker reflects what the selected model can
  actually transcribe**, instead of a fixed 7-option dropdown (auto-detect
  plus 6 languages). A multilingual Whisper model now offers its full
  published set (99 languages, 100 with `large-v3`'s Cantonese support);
  Parakeet TDT v3 offers its 25 supported European languages; an
  English-only model states that in a sentence instead of showing a picker.
  Saving a language selection is validated against the selected model's real
  coverage rather than a fixed 12-language allowlist that used to accept
  languages an English-only model couldn't handle and reject languages a
  multilingual model could.
- Recording encryption now streams in fixed 1 MiB frames instead of holding
  a whole track (and its ciphertext copy) in memory, and checks free disk
  space first — if there isn't enough, it defers encryption and keeps the
  recording intact rather than failing the meeting stop.
- Learned dictionary corrections (names, jargon, product names taught via
  the personal dictionary) now apply to meeting transcripts, summaries,
  action items, and auto-generated titles, not only to live dictation.
- Custom dictation mode prompts are now honored when built on the Messages,
  Email, or Meeting Follow-up presets, not only on the default preset.
- Systemwide text insertion at the end of a dictation now runs off the async
  runtime, removing an up-to-one-second stall it previously caused elsewhere
  in the app.
- Disk-space thresholds for an in-progress meeting are now sized to how
  many audio tracks that meeting actually writes (microphone-only vs.
  microphone-plus-system-audio) instead of one fixed byte budget that
  refused or warned mic-only meetings too early.
- Model currency: the Gemini analysis default is now `gemini-3.7-flash`; the
  OpenAI analysis default is `gpt-5.6-luna`; the DeepSeek default is
  `deepseek-v4-flash`; the Ollama default is `qwen3.5:4b` (matching the
  Settings empty-state hint, which also now suggests `ollama pull
  qwen3.5:4b`); the OpenAI cloud dictation default is `gpt-transcribe`
  (meeting-lane OpenAI transcription stays pinned to `whisper-1`, the only
  OpenAI cloud model that returns the segment timestamps meetings need); and
  the ElevenLabs default is `scribe_v2` (`scribe_v2_realtime` was
  websocket-only and could never work through this app's upload path).
  Context-window budgeting now recognizes GPT-5.x and Gemini-3.x models'
  real ~1M-token windows instead of clamping them to a stale estimate.
- The stored meeting-lane default now names the route the meeting lane
  actually runs: `parakeet` / `parakeet-tdt-0.6b-v3`. It was stored as
  whisper.cpp `base.en`, but whisper.cpp has never been a meeting-supported
  provider, so that slot was never read and every fresh install already
  transcribed meetings with Parakeet. A settings file still carrying the old
  `whisper`/`base.en` meeting pair is rewritten to Parakeet on load; shared
  dictation/meeting selection is untouched. No transcription behavior
  changes; the settings file stops claiming a route that never ran.
- The unused `toggleDictationAlternates` shortcut key is gone from the
  settings schema (it was only ever written as an empty list). Old settings
  files that still carry it load cleanly and are rewritten without it.

### Fixed
- The streaming live preview no longer shows a word twice. When the recognizer
  reported a shorter settled prefix than the popup was already showing —
  ordinary flicker, and deliberately ignored — the tail that came with it was
  pasted on unchanged, so "ship the" followed by "ship" + " the release" was
  drawn as "ship the the release". The tail is now re-cut at the boundary the
  popup kept.
- The diarization model chosen in Settings is now the one the automatic
  post-meeting speaker pass uses. It previously always ran ECAPA-TDNN no
  matter what the picker said; only the explicit "identify speakers" action
  honoured the setting.
- Choosing a speaker model you have not downloaded no longer costs you speaker
  labels. "Is this model ready" was answered by checking ECAPA-TDNN whatever
  model was asked about, so picking CAM++ (or ResNet34, or ERes2NetV2) without
  downloading it passed the check and then failed inside the run, silently, on
  every meeting. Readiness now checks the model you picked; if it is missing,
  the meeting is diarized with the downloaded default and says so — "Speaker
  labels used ECAPA-TDNN 512 because CAM++ is not downloaded." With nothing
  downloaded at all, no speaker labels are claimed.
- The MODEL WEIGHTS section of THIRD-PARTY-NOTICES.txt now also accounts for
  the pyannote community-1 bundle the experimental diarization backend fetches.
  No shipped build enables that backend, but its pin lives in the sidecar
  source, and the notices record what the mirror actually declares: nothing.
  Upstream is CC-BY-4.0 and gated; that is stated as upstream's terms, not as
  the mirror's, and the artifact is counted among those awaiting a human
  answer.
- THIRD-PARTY-NOTICES.txt now has a MODEL WEIGHTS section naming every model
  Plainsong can download — repository, pinned revision, files and license —
  including the terms that differ from the code's: Parakeet's CC-BY-4.0
  attribution and S1-mini's naming clause. The section is generated from a
  manifest and covered by the release license gate, and it records honestly
  the one artifact whose upstream declares no license.
- Speaker models now appear in the list of downloaded models, and can be
  deleted. The four speaker embedders and any experimental pyannote bundle were
  downloaded into the models directory and then never enumerated, so they were
  invisible in the Models screen and there was no path to delete them. Deleting
  a multi-file model (a speaker bundle, Qwen3-ASR, the built-in cleanup model)
  now removes the whole directory instead of failing; the managed models
  directory itself is refused.
- The built-in cleanup model's 473 MiB now appears in the sidecar's list of
  downloaded models, where it was missing entirely. The Models screen's
  "Speech models on this Mac" total still counts only speech models, since
  that is what it says.
- "Keep the model warm: off" now actually releases the built-in cleanup
  model. It used to skip only the warm-up — the first dictation loaded the
  model anyway and it stayed in memory for the rest of the session — so the
  switch saved nothing after your first capture. With it off, the model is
  unloaded a minute after the last dictation, and switching the dictation
  lane to Ollama or a cloud provider releases it immediately. The Models
  screen states what it holds while loaded.
- The Models screen now says which processor the built-in cleanup model runs
  on, and Plainsong no longer starts a new install on that route where it
  would be too slow. On a Mac that falls back to the CPU a 200-word dictation
  takes 11 to 13 seconds against a six-second limit, so the row says so and
  the dictation lane starts on Ollama instead; choosing the built-in model
  there is still yours to make.
- The Apple on-device model row says "Still downloading" while Apple
  Intelligence is fetching its model, instead of "Not available" — a wait,
  not a verdict about this Mac.
- A dictation cleanup that runs past its time limit now stops within a
  token instead of running to the end of its budget. The built-in model
  (S1-mini by Superwhisper) is held behind one lock, so an abandoned cleanup
  used to leave every later dictation of the session waiting on it with the
  GPU still busy; the first slow cleanup no longer breaks the rest.
- The built-in cleanup model can no longer put its own markup into your
  document. A reasoning block or a stray chat-turn marker in the model's
  output is removed, and a result that is nothing but reasoning falls back
  to the text the local pipeline already produced.
- Chat-turn markers in a transcript — reachable through a dictionary
  replacement you wrote yourself — are rewritten as plain text before the
  built-in model sees them, so a dictation cannot open a second turn and
  address the model as its instructions.
- A question that starts with a path can be asked again. Any leading "/"
  opened the saved-prompt picker, and both chat boxes refuse to send while it
  is open, so "/Users/me/notes.txt is failing to import" could not be sent at
  all. The picker now closes as soon as nothing matches what you typed, and
  its footer says Esc closes it.
- A pre-meeting brief's citations are numbered references you can click,
  each naming the meeting it came from, instead of the raw "L1"/"L4" evidence
  IDs the model wrote.
- A saved-prompt change that fails to write now says so in the Manage prompts
  dialog. Settings reported every such change as saved without waiting to
  find out.
- Attendee names arriving from a calendar invite are stripped of bidi
  overrides and control characters before they are shown, exported or put in
  a prompt.
- "Prepare" on a calendar cue no longer reads the whole meeting library to
  look at the newest few hundred.
- Numbers as digits no longer reads an ordinary sentence as a date. "I may
  second that motion", "we may first go" and "I march second in the parade"
  keep their words; a month name that is also an ordinary word now needs a
  year, a date word in front of it, an explicit "the", a clock time after
  the day, or the head of a phrase before a day converts.
- Numbers as digits no longer drops punctuation that sits inside a phrase it
  rewrites: "ten per (cent", "the first of (May" and "twelve dollars and
  fifty (cents" keep their parenthesis.
- A one- or two-letter dictionary correction no longer splits a number it
  merely appears inside — "twenty five servers" came out "20 five servers"
  when a correction replaced text with "v".
- A phrase expansion whose trigger contains a spoken number now still fires
  with Numbers as digits on; "two factor auth" was being rewritten to
  "2 factor auth" before the expansion could match.
- Numbers as digits no longer runs over the result of a voice command, so
  "replace two with three" can only change what it was asked to change and
  leaves the rest of the previous insertion alone.
- Numbers no longer come out half-written. "ten to one odds", "point five"
  and a spoken digit run of a length with no phone shape stay as words, and
  a run containing a spoken "oh" is written whole — "room two oh one"
  becomes "room 201" rather than "room 2 oh one". A time preposition also
  stays in scope across a list, so "at three fifteen, three thirty and three
  forty five" is three times.
- Large numbers are written with thousands separators the way they would be
  typed: 75,000 for cardinals from ten thousand up, $1,200 for currency from
  one thousand up. Years never get one.
- "twenty-one" now converts like "twenty-first" already did, with either the
  ASCII hyphen or the non-breaking hyphen some decoders emit.
- The AI formatting pass is now told to keep numerals, currency, times and
  dates exactly as written, so it cannot spell out what Numbers as digits
  just wrote.
- The model manager now lists the GGUF weights under
  `models/transcribe_cpp`, and deleting one removes the file and its
  integrity receipt. They were downloadable but invisible, so up to 1.42 GiB
  could sit on disk with nothing in the app able to show or reclaim it.
- A meeting only stops itself for a call ending when it is the call whose
  offer was actually accepted. A recording started any other way, or started
  from an offer that was waved away, is no longer ended because some
  unrelated conferencing app quit.
- Call detection no longer announces "Google Meet call started" for a
  browser tab that merely has the word "Meet" in its title. It now matches
  Google's own title shapes and, for the browser route, also requires the
  microphone to be open by another process.
- A browser is only asked for its window titles when the microphone is
  already open elsewhere or when it is where the current call was found;
  reading them every few seconds switched Chromium into full accessibility
  mode for good. Each window read now carries its own quarter-second
  timeout, so an unresponsive browser costs a poll a fraction of a second
  rather than a minute.
- A meeting going quiet is now warned about at half the silence fuse ("No
  audio for 7 minutes; Plainsong stops this meeting in 8 unless sound
  resumes") instead of only in the sentence that announces the stop.
- Pauses are written to the meeting as they happen rather than only at stop,
  so a crash mid-meeting keeps the markers of where the gaps are.
- Stopping a meeting while it is paused no longer appends the audio the
  mixer was holding back from during the pause, and time spent paused no
  longer counts toward the "captured seconds" a degraded meeting reports.
- The "Zoom call started" notification no longer fires while Plainsong is
  the frontmost app, where the Meetings header already shows the same offer;
  and a shown notification is kept alive until it is clicked or dismissed,
  so its click still opens the consent sheet minutes later.
- A meeting recorded alongside a detected call, and one started from a
  calendar event, now both carry that call's or event's conferencing service
  on the recording.
- Onboarding's line about call detection now names Slack and Discord, which
  detection has always matched.
- **The vault's database encryption step did not encrypt the database.**
  Turning the vault on generated a key, stored it durably in the macOS
  Keychain, reported "database encrypted", and left `plainsong.db` readable
  by anything that could open the file: the step used `PRAGMA rekey`, which
  SQLCipher documents as a no-op on a connection that was never keyed, and it
  returns success either way. Encrypted meeting audio and Keychain storage
  were not affected. The migration is real now — `sqlcipher_export` into a
  fresh keyed database beside the original, the schema version carried across
  by hand (the export does not carry it), fsync, a check that the new file
  opens with the key and does *not* open without it, then an atomic rename
  over the original; any failure before that rename removes the staging file
  and leaves the plaintext original intact and open. Every install that
  turned the vault on is in the "key stored, database plaintext" state, so
  the app detects it at launch and runs the migration then, holding the same
  vault-migration exclusion the Settings path holds, writing an audit event,
  and telling you in the app that it happened. A migration that cannot finish
  no longer stops the app from launching: it keeps working on the plaintext
  database and reports the database as not encrypted, which is the truth. The
  `plainsong` CLI now probes rather than trusting the Keychain, so it opens
  either kind of database and its `stats` reports the file's real state.
  Note the one thing an atomic rename cannot do: it unlinks the old plaintext
  pages rather than overwriting them, so they stay recoverable on the volume
  until reused. See docs/beta/PRIVACY-AND-CLOUD.md.
- The `plainsong` command read its Local tools switch through a path that
  honours `PLAINSONG_CONFIG_DIR`, so anything that could set that variable
  could point the gate at a settings file it wrote itself while the database
  path and its Keychain key stayed real. The gate now reads only the file the
  app writes.
- A meeting note, transcript or dictation containing a multi-byte character
  immediately before the text `untrusted_content` crashed the MCP server
  mid-response (a byte-offset slice landing inside the character). The frame
  neutraliser also missed `</ untrusted_content>` — whitespace inside the tag
  punctuation — which a lenient reader would still take as the frame ending.
- The `plainsong` CLI's `stats` read and parsed every transcript in the
  database to count how many recordings had one; it is a single query now.
- The read-only database open sets its busy timeout before the first statement
  that touches the file rather than after, so a reader started while the app
  is mid-write waits instead of failing.
- `get_meeting` over MCP capped only the notes field, so a long summary, a
  wall of action items, or a provider's error message pasted into the meeting
  could each blow past the 60k result budget on their own. Every field is
  capped now, with one `truncated` flag and the real action-item count. The
  provider error text and the meeting template id are also wrapped in
  `<untrusted_content>` frames like the rest of the meeting's text.
- The MCP server now enforces the 2026-07-28 revision's per-request rule that
  a client declaring that version also sends its capabilities (`-32602`
  otherwise), and answers `server/discover` in the modern shape even when the
  request carries no `_meta` at all, which is how a client that does not yet
  know a version has to ask.
- An over-long MCP request line was refused and then drained through the
  unbounded reader, which handed back exactly the allocation the size cap
  exists to refuse. It is drained through the bounded reader now.
- "Install command-line tool" treated any symlink at `/usr/local/bin/plainsong`
  as one of Plainsong's own and replaced it; a link pointing at anything but a
  `plainsong-cli` binary is now left alone and reported as occupied. The
  install also no longer unlinks before it symlinks — it writes the link under
  a temporary name and renames it into place, so a failure can no longer leave
  the machine with no `plainsong` command.
- Opening an encrypted (SQLCipher) database failed every time with "Execute
  returned results": the key check ran a `SELECT` through rusqlite's
  `execute`, which refuses any statement that returns rows. No install had a
  vault key yet, so nothing caught it until the read-only CLI open was tested
  against a keyed file. The open and rekey paths now verify the key with a
  query. Found while adding the local tools; regression-tested in
  `db::tests::keyed_open_round_trip`.
- Opening the same meeting's audio repeatedly no longer decrypts it again
  every time: each open used to write another full-length plaintext copy that
  stayed on disk until the vault locked (twenty opens of a two-hour meeting
  left roughly fourteen gigabytes behind). Players for one meeting now share
  the one decrypted copy, playback decrypts only the track it actually plays
  instead of all three of a dual-track meeting, and a fourth meeting opened
  for playback at once is refused with a message that says to close one.
  Reloading the window, a renderer crash, a preparation that timed out, and
  "Reset app state" all release the tokens they leave behind, so the
  decrypted audio goes with them.
- A subtitle cue for a very short turn no longer runs over the top of the
  next cue: it is still held long enough to read, but never past the moment
  the next speaker starts.
- The Word export no longer italicises identifiers: `file_name_here` keeps
  its underscores, because `_` now marks emphasis only at a word boundary.
- An action item whose owner the meeting called by their first name is no
  longer dropped when the speaker alias or the transcript spells the name out
  in full ("Priya" against "Priya Raman", "Jon" against "Jonathan").
- Following the audio no longer re-renders the whole Meetings view about four
  times a second, and the up and down arrow keys inside the transcript no
  longer move the reading position while a control in it has focus.
- "Open audio file" and the stored waveform could not open a recording
  encrypted by the streaming vault writer: the runtime decrypt path still
  ran the pre-streaming whole-file decoder on every file, which fails the
  integrity check on a PSVAULT1 payload. It now streams PSVAULT1 frames into
  the temporary file and uses the whole-file decoder only for legacy
  payloads, which is also what keeps a long meeting out of memory.
- Dictation bindings refuse the chords macOS owns (Cmd+Q, Cmd+W, Cmd+Tab,
  Cmd+Space, Cmd+H, Cmd+M), and a modifier on its own can only be Fn — a lone
  Cmd would have started dictation from an ordinary pause mid-chord. Both the
  sidecar and the Settings screen say so in the same words.
- A shortcut written with the macOS symbols kept its modifiers. The sidecar
  was deleting them when it normalized a trigger, so a symbol chord read as
  its bare key: it could fail validation as "ordinary typing", and two
  different chords could look like the same trigger.
- A binding whose activation behavior was missing or unrecognised is now read
  as "follows the setting above" instead of being dropped, matching what the
  sidecar already did — the two sides could otherwise register different
  hotkeys from the same file. Only F1 through F24 count as a function key.
- The first click of an extra mouse button on a binding's recorder now
  registers. It was discarded because the click had not focused the field
  yet, so binding a mouse button took two clicks.
- The "next profile" notice reaches a dictation overlay that had to be
  created to show it, instead of arriving before that window could listen.
- The dictation HUD's "next profile" notice is rust and neutral instead of
  gilded. Picking a profile is a mode selector, and gilding it competed with
  the live recording moment gold is reserved for.
- "Next profile" now walks the profiles in the order their tiles are shown,
  so the ready-made Coding and Quiet profiles land where you see them rather
  than behind whatever you built yourself.
- A binding saved as hold-to-talk on a machine where the native shortcut
  helper is not running no longer reads as "Follows the setting above". The
  hold option is shown, disabled, with the reason, and the row says the
  binding presses to start and presses again to stop until the helper is
  available.
- Editing a dictation binding while recording no longer strands the
  recording. Each edit saves immediately, and the native shortcut helper takes
  its whole binding table on launch, so the save killed and respawned it —
  swallowing the key release of a hold in progress and leaving the session to
  run until the 10-minute watchdog. A new table is now held back while a
  session or a held key is in flight and applied the moment things go idle,
  and a helper that is replaced anyway hands over the release it owes.
- "Add binding" no longer creates a row that disappears. The new row was
  saved immediately with no keys recorded, and the sidecar drops a binding
  with no trigger, so it survived on screen only until the next reload. The
  row is now held unsaved until the recorder captures a trigger, and written
  the moment it does.
- A dictation binding on the same keys as Open window (or either recovery
  shortcut) now says so in Settings. Dictation bindings are registered first
  and take the keys, so the other shortcut silently stopped working with only
  a line in the console; the conflict check walked the four legacy shortcut
  fields and could not see the binding table at all.
- Two dictation bindings on the same trigger no longer fail the whole
  settings save. The sidecar rejected the entire payload — losing every
  unrelated edit saved with it — where the app's own Settings screen only
  warned in the row. The later of two identical triggers is now dropped on
  save, which is all that could ever have happened anyway, and the row says
  so.
- The wait in front of an insert is now capped once, not once per pass. A
  dictation that both translates to English and then formats used to take a
  full formatting timeout for each, so the real worst case before a word
  appeared was twice the stated budget (12 s on the local split). Both passes
  now share one budget; whatever the first spends is taken off the second.
- Translate to English no longer runs a hidden AI pass on an English-only
  whisper model. Turning the switch on under a multilingual model and then
  switching to a `.en` build left the setting stored as on while the switch
  showed off and disabled, so every English dictation paid for a second model
  call before insertion. The stored flag (built-in profiles and each saved
  profile) is now cleared on save, and the runtime route refuses the case
  independently.
- A mic failure mid-meeting in a "me and them" (microphone plus system
  audio) recording is now detected and noted on the meeting instead of being
  silently padded with silence and presented as a complete recording; a
  replugged microphone can recover without ending the meeting.
- A meeting whose Stop step failed for an unrelated reason after its audio
  was already safely written no longer has that audio condemned — it stays
  usable, and the app can self-repair such meetings on next launch.
- Stopping a meeting can no longer hang indefinitely behind a background
  storage sweep; capture now ends within about 10 seconds regardless.
- Storage-retention cleanup no longer deletes the source audio of a meeting
  whose transcript came out incomplete until the user explicitly
  acknowledges the loss (or it's successfully re-transcribed).
- A mid-meeting warning banner no longer erases the live transcript preview,
  the elapsed timer, or the lost-audio counter already on screen.
- Retired the non-functional "macOS MLX sidecar (advanced)" dictation
  engine: its download step only ever wrote a stub marker file, so selecting
  it always failed transcription. It no longer appears in Settings, and
  installs that had it selected are moved off it automatically.
- A panic in one background worker (a WAV writer, a transcription task, an
  audio callback) no longer takes down the whole local transcription
  process; that one component fails and the rest of the app keeps running.
- Downloaded model integrity receipts are now HMAC-protected with a
  keychain-held key rather than a plain hash, and an accidentally-empty
  pinned digest can no longer silently disable verification of a downloaded
  model file.
- A manual "Retry" on meeting analysis can no longer run alongside an
  automatic analysis pass for the same meeting, and the capture-admission
  check introduced in the prior wave is now actually enforced rather than
  decorative.
- Sidecar-loss and meeting-start failures now show one plain-language
  message and one action instead of a raw process-exit log line or generic
  advice glued onto an unrelated error (for example: "Plainsong does not
  have microphone access, so there is nothing to record" with an "Open
  Microphone settings" action, distinct from a system-audio or disk-full
  failure). A capture source that hard-fails is now described as failed,
  not as having "gone silent," which previously read as a muting problem.

### Removed
- The never-reachable "post the consent notice into the meeting chat for
  you" automation for Zoom and Google Meet. Its keystroke senders sat behind
  a gate that was hard-wired to off because nothing could prove the meeting
  app's chat field had focus, so no build ever sent a notice. The start
  sheet, the recording popup, and the beta docs now say plainly that
  Plainsong does not post the notice; the notice text and its Copy button
  stay. Automation can only come back with a positive focus-verification
  design and on-device QA.
- The ML punctuation/casing model (`punct_cap_seg_en`, ~210 MB) and the
  `text-recasepunct` build feature. Its restore function had no caller, and
  every shipped speech route already emits punctuated, cased text (see
  docs/model-inventory-upgrades.md item 9 for the per-route table), so the
  download existed to fix a problem no route has.

### Security
- The window title a call was detected through no longer leaves the sidecar.
  It was broadcast to every app window on `meeting-call-detected`, and for
  Google Meet that title is the meeting's own name; only whether a window
  was involved travels now. `docs/beta/PRIVACY-AND-CLOUD.md` says exactly
  what detection reads and what it keeps.
- Dictation now refuses to deliver into password boxes and other secure
  inputs. Before the direct Accessibility write, before the clipboard +
  Cmd+V fallback, and before the Cmd+C used to read a selection, the sidecar
  checks the focused control (`AXSecureTextField` role/subrole), letting
  macOS's system-wide secure-event-input flag decide only when the control
  cannot be inspected; when the check says "secure", nothing is inserted,
  nothing is staged on the clipboard (clipboard-only mode included), the
  words stay in dictation history, and the popup reports the distinct
  `secure_field` outcome in plain language with the Copy action still
  available. The paste fallback re-probes immediately before it touches the
  clipboard, so focus moving between the first check and the paste cannot
  slip a password box in. Previously this was left to whatever the target
  app did with a synthetic paste.
- `shell.openExternal` and in-app link navigation now check a fixed host
  allowlist before opening anything in the user's browser; a link to any
  other host is refused and logged, not opened.
- The dictation and recording overlays can no longer be resized past a fixed
  cap or shown while the user has that overlay turned off; native folder
  dialogs (export, backup, cloud backup) now require a real click or key
  press in the main window; the main window itself rejects unbounded resize
  or move requests; and every `ipcMain` handler now requires a trusted
  top-level frame as its sender.
- The renderer bundle now serves its Content-Security-Policy (including
  `frame-ancestors 'none'`), `X-Content-Type-Options`, and `Referrer-Policy`
  as real headers on every asset the app serves, not only as a `<meta>` tag
  on `index.html`.
- Auto-update now verifies the running app's code signature and Apple
  Developer team before handing off to an installed update, and refuses
  with a manual-download message if either check fails. It previously only
  displayed the signature and rejected exactly the literal string
  `Signature=adhoc`, so any other signature — including one from an
  unrelated Developer ID — passed through unchecked.

### Release infrastructure
- `CFBundleVersion` is now a real integer build number
  (`encodeBundleBuildVersion`, e.g. `900302` for `0.9.0-beta.2`) instead of
  the literal semantic-version string, which macOS has no ordering for.
  `CFBundleShortVersionString` still carries the full semantic version.
- The release DMG now lays out the app icon and an `/Applications` shortcut
  in a sized window instead of Finder's default, unstyled placement.
- macOS entitlements are now split per binary instead of every Electron
  helper process copying the main app's entitlements: the GPU, Renderer, and
  Plugin helpers are narrowed to JIT/inherit only; the generic helper that
  hosts Chromium's audio service keeps audio and nothing else; the sidecar
  and shortcut helper carry no entitlements at all; and
  `com.apple.security.cs.disable-library-validation` has been removed from
  the main app's own entitlements (flagged for packaged-QA verification — if
  a packaged build fails to launch because of this, the fix is to sign the
  offending library, not restore the entitlement).
- The public update feed is now resolved per channel: `/beta/` and
  `/stable/` are separate manifest directories, and the running app
  re-resolves its feed URL from the active channel at check time instead of
  trusting a single URL baked in at build time. A future stable release
  requires publishing `/stable/latest-mac.yml` before stable installs can
  check for updates at all.
- `scripts/build-dmg.mjs` (the local, ad-hoc DMG builder — not the release
  path) now prints an unmissable runtime warning that its output is not a
  release artifact and does not notarize, staple, or apply the release DMG
  layout. The `0.9.0-beta.2` DMG shipped unnotarized because this script was
  used instead of `bun run release:mac`; the warning now prints before and
  after every local build.

## [0.9.0-beta.2] - 2026-08-23 (integration candidate)

This private candidate reconciles the full dual-pillar beta with current
application, Rust, and workflow dependency updates. It repairs exact-candidate
QA receipt wiring, separates measured latency from clean-checkout source gates,
closes release-workflow verification gaps, and fixes validated Dictation and
Meetings lifecycle defects before a new package is qualified.

### Repaired
- QA receipt wiring: aggregators and producers now agree on `release/qa` paths.
- Latency gate: self-sufficient source gate separated from measured receipt.
- Release workflow: license and cold-start gates added; Windows publish-on-tag
  removed.
- Meeting lifecycle: stop failures now surface to the user instead of causing
  unhandled rejections; renderer and main-process lifecycle events reconciled.
- Capture admission: privileged storage operations guarded.
- Electron 43 module resolution: process-scoped imports (`electron/main`,
  `electron/renderer`, `electron/common`) resolved for both runtime and tests.
- `nanoid@3.3.18` security fix applied via package.json override.
- Dependency updates from all three Dependabot branches reconciled.

### Verified locally
- 868 Vitest tests, Rust library and binary tests, IPC contract, dead-code,
  TypeScript, renderer build, Electron build, Rust fmt and Clippy.
- Local package: native helpers, licenses, third-party notices, Electron fuses,
  Developer ID signatures, hardened runtime, secure timestamps, arm64, zip
  extraction, size gate (374 MB), cold-start gate (2428 ms).

No `0.9.0-beta.2` artifact has been notarized, stapled, or distributed. Signing,
notarization, Gatekeeper, clean-install, real-device, and updater claims require
fresh evidence from the exact final revision.

## [0.9.0-beta.1] - 2026-08-08 (historical candidate)

The free, open-source relaunch. The previously commercial app (NautilusBot /
Nautilus) was rebuilt as **Plainsong** — MIT licensed, no trial, no tiers,
no telemetry. This limited beta targets macOS on Apple Silicon (arm64).

Dictation and Meetings are both supported release pillars. The beta adds
explicit runtime readiness, bounded recovery, local-first remote-processing
revocation, guarded privileged storage operations, rollback-resistant beta
updates, and exact-candidate QA receipts. The first invite-limited group accepts
the formal real-device Dictation matrix, remaining Meeting lifecycle rows, and
a repeat three-hour capture soak as documented beta risks. They remain required
before public launch. Distribution still requires explicit approval, and
automatic updates remain gated on the exact-candidate updater journey and
publication of the beta update feed. Its historical receipts do not establish
those states for later candidates.

### Added
- **Hold-to-talk dictation**: true press-and-hold via a native macOS
  CGEventTap helper, with automatic fallback to toggle if the helper is
  unavailable.
- **Hands-free dictation**: voice-activity auto start/stop, with an optional
  Silero VAD (ONNX) model download for higher accuracy than the built-in
  energy-threshold gate.
- **Destination-app-aware AI formatting**: dictation cleanup adapts to the app
  being dictated into (email, messaging, AI chat, code editor, notes), with
  per-app overrides.
- **Voice/palette editing of selected text**: Cmd+K commands (shorten, expand,
  proofread, tone rewrite, translate, and more) that replace the selection in
  place.
- **Live streaming partials**: words appear in the overlay as you speak
  (UI-only; never changes the inserted text).
- **Menu-bar tray** with Open/Quit and a minimize-to-tray setting; multi-monitor
  and notch-aware placement for the dictation/recording overlays.
- **Shortcut-conflict detection** with an inline warning in Settings.
- Dictionary/snippet **category scoping**, a "recently learned" list, and a
  capitalization-only quick action.
- Real dictation latency benchmark (`bun run benchmark:latency`) measured on a
  real spoken-speech fixture (`scripts/fixtures/real-speech-44s.wav`).

### Changed
- **Renamed** end-to-end to Plainsong: bundle id `com.plainsong.app`, sidecar
  binary `plainsong-sidecar`, data directory, and all brand text (pre-launch,
  so no data migration).
- Renderer restyled to the manuscript brand (see `STYLE.md`); themes collapsed
  to two.
- Default local route is whisper.cpp (Metal) `base.en`; hot path
  unblocked (concurrent JSON-RPC dispatch, model pre-warm, in-process
  frontmost-app lookup).

### Removed
- All commercial licensing, trial, nag, and entitlement code.
- Telemetry/analytics: none ship; keys live in the OS keychain; dictation audio
  is never persisted (see `../PRIVACY.md`).

## [Pre-relaunch] - 2026-03-02

Work recorded before the rename to Plainsong; names below reflect the app as it
was then.

### Added
- Added benchmark launch gate verifier (`scripts/verify-benchmark-gates.mjs`) for CP-13/CP-14/CP-15 thresholds.
- Added benchmark gate artifact schema (`docs/ci/schemas/benchmark-gate-result.schema.json`).
- Added owner/evidence placeholders across all packaged QA matrix rows.

### Changed
- Updated release cold-start gate process matcher to target the then-current packaged binary `nautilus-bot` (now `plainsong-sidecar`).
- Updated competitor parity command docs (the project has since standardized on bun).
- Updated release/prelaunch readiness docs with current gate status and blockers.
- Improved artifact validator support for `date-time` formats and regex `pattern`.
- Stabilized the recordings view cross-meeting recall test so it waits for the recall button before clicking ([PR #9](https://github.com/JonathanRReed/Plainsong/pull/9)).

### Security
- Updated lockfile dependencies to remediate Rollup path traversal advisory.
