# Privacy

Plainsong is local-first. This document describes, plainly, what happens to your
audio and text. The source is open for inspection.

## The short version

- **By default, your audio is transcribed on your machine** and never leaves it.
- **There is no telemetry or analytics.** Plainsong does not phone home, count
  usage, or report crashes anywhere. (Verified: no analytics/telemetry SDKs in
  the codebase.)
- **No Plainsong account, API or cloud storage.** We don't host an account
  system or store your data anywhere. The only service we run is the update
  feed described below, and it receives nothing about you beyond a normal web
  request.
- **We never take screenshots.** Nearby spelling is off by default. If you
  enable it, Accessibility reads visible text near your typing location and
  extracts a short vocabulary for local spelling correction. Raw text and unused
  vocabulary are never saved or sent to a provider. Some dictation modes can
  separately use your clipboard or selected text for formatting. That context
  defaults to off and can reach a cloud provider if you choose cloud AI cleanup.

## Database migration snapshots

Before upgrading an existing vault-encrypted database's schema, Plainsong
exports an encrypted snapshot with the same vault key. It keeps the two newest
snapshots in `plainsong.db.migration-snapshots` beside the database. Snapshot
names include the time and old and new schema versions. The key is not copied
to that directory. A snapshot contains database text and metadata, including
transcripts and notes, but no audio files. These copies remain on this Mac and
are not added to cloud backups by this feature.

Snapshots can retain entries deleted after the snapshot was made. They remain
until a later migration replaces them or you delete the snapshot directory.
Deleting the app's data directory removes them too. Startup stops before the
migration if it cannot make and verify the encrypted copy. A failed schema
migration rolls back its database transaction and keeps the snapshot. The
current backup restore screen cannot restore vault-encrypted snapshots.
Profiles without database encryption keep their existing startup behavior;
this feature never creates a plaintext migration snapshot.

## What does connect to the network

Local processing can still need a model download. The following actions can
make network requests. Download hosts and providers see your IP address and
normal request headers.

- **Downloading a speech model.** When you choose Download, Plainsong fetches
  the selected model from Hugging Face. Parakeet TDT 0.6B v3 is about 640 MB
  in ONNX. On Apple Silicon with macOS 14 or later, Parakeet's Download
  fetches pinned files from Hugging Face (`huggingface.co/FluidInference`):
  the Core ML build of Parakeet (632 MB, or 464 MB for the
  English-only build when your transcription language is English) and, when
  dictation can be English, a 103 MB vocabulary model (Parakeet CTC 110M)
  that checks the names and terms you add against the audio. The size shown
  before you choose Download is the total: about 735 MB with automatic
  language detection, about 567 MB for English, 632 MB for other languages.
  On Apple Silicon with an earlier macOS the Download is a 740 MB GGUF file. Plainsong
  also fetches that 740 MB file in the background, with progress in
  Settings > Models, if the Core ML build cannot run on your Mac
  (dictation with Parakeet waits for it), or if a developer setting forces
  that build. If Parakeet was already on your Mac before this version, or you
  later switch the transcription language between English and another
  language, Plainsong fetches the missing files in the background and shows
  the progress in Settings > Models. Nothing downloads in the background
  before you have chosen Parakeet's Download. Hugging Face sees each request,
  and therefore your IP address, the same as any other download. It happens
  once per model. Nothing about your audio, transcripts, or usage is
  included.
- **Downloading an optional English speech model.** Fluid Speech Mini and
  Underdog Bark 3.0 Pro are converted by Plainsong and downloaded, with
  their license and credits, from Plainsong's own GitHub release
  (`github.com/JonathanRReed/Plainsong`, which hands the file to GitHub's
  download host). GitHub sees that request and your IP address. Each file
  must match its pinned SHA-256 before Plainsong accepts it.
- **Downloading cleanup and text models.** S1-mini by Superwhisper, the
  built-in dictation cleanup model, runs locally. Light notes use Qwen3 1.7B.
  Balanced and Best use Qwen3 4B Instruct. Their weights and license files
  come from Hugging Face when you choose Download or restore them in Models.
  Files are pinned and checked against their expected SHA-256. These requests
  contain no dictation or meeting content. Once installed, a local helper
  processes the text on your Mac.
- **Downloading Whistle.** Choosing Download for Whistle fetches both the
  speech model and the native needle executable from Hugging Face. Both are
  pinned and checked before use. Transcription then runs locally.
- **Installing an Ollama model.** Plainsong asks your configured Ollama
  service to pull the model you choose. Ollama contacts its model registry to
  fetch the files. A local Ollama service does this from your Mac. The install
  request identifies the model; it does not include your recordings or text.
- **Loading a provider's model catalog.** With cloud processing enabled,
  choosing a provider in Models or API keys, saving its key, or pressing its
  refresh button can request that provider's model list using its credential.
  Opening Models or Search & AI does not fetch every configured cloud catalog.
  Catalog requests contain no audio or meeting text. Opening those tabs can
  query the local Ollama service for its installed models. ChatGPT account
  connect, select and refresh actions can load that account's OpenAI catalog.
- **Installing an Apple speech language.** If you choose to install a missing
  language for Apple Speech, macOS downloads its speech assets from Apple.
  This is a system-managed download, separate from on-device recognition.
- **Downloading a search model.** Searching past recordings by meaning uses a
  text model that runs inside Plainsong. New installs start with meaning
  search selected, but the model downloads only when you click Download in
  Settings or under Ask. The default, EmbeddingGemma 2, is about 346 MB
  from Hugging Face. The optional EmbeddingGemma 300M downloads only after
  you accept the Gemma Terms of Use in the app; Plainsong keeps a record of
  that acceptance (the model, the terms' address and the time) in its
  settings on your Mac and sends it nowhere. Each URL is pinned to a model revision and each file
  must match its pinned SHA-256. Until it is downloaded, Ask matches words.
  Your transcripts, your questions and the search index stay on your Mac.
- **Downloading optional Silero voice-activity detection.** If you enable the
  higher-accuracy Silero VAD model, Plainsong downloads its ONNX file from
  `raw.githubusercontent.com`. The URL is pinned to an upstream commit and the
  file must match the expected SHA-256 before Plainsong accepts it.
- **Downloading a speaker model.** Speaker labels need a speaker model on
  your Mac, and Plainsong downloads one only when you click Download: in the
  meeting step of first-run setup, which names the model and its size beside
  the meeting speech model and downloads whichever of the two you still need
  in one click (skip meetings and neither downloads); under Settings >
  Transcription; or on a meeting that was saved without speaker labels.
  Recording or transcribing a meeting never downloads one. If the
  model you selected is missing, the meeting uses another speaker model
  already on your Mac and says which; with none, it is saved without speaker
  labels and says so. The WeSpeaker ECAPA-TDNN, ResNet34, CAM++ and
  experimental Nemotron models come from Hugging Face. ERes2NetV2 is
  turned off while its license is unresolved: Plainsong no longer downloads
  or runs it, and an earlier download stays on your Mac until you remove it in
  Settings > Meetings. The pyannote community-1 files (with their license and
  notice) come from Plainsong's own GitHub release, as above. Each URL is
  pinned to a model revision or release and each file is checked against its
  expected SHA-256.
  pyannote's own Python library reports usage to pyannote by default;
  Plainsong does not use that library, and its community-1 code sends nothing
  anywhere.
- **Checking for updates.** When you ask Plainsong to check for a new version, it
  requests the release manifest from `updates.plainsong.jonathanrreed.com`, a
  small Cloudflare Worker run for Plainsong that reads the public GitHub
  releases and passes the release files through. The request carries only the
  file name and normal web headers, which can include the app version; the worker keeps no records of its own,
  and Cloudflare, which hosts it, sees your IP address as any web host does.
  There is no automatic check on launch and nothing downloads without your
  say-so.

With the models installed and local routes selected, transcription, cleanup,
meaning search and meeting analysis run on your machine. Optional cloud routes,
account sign-in and the requests listed here have the separate data flows below.

## What local-first means here

Privacy is a property of Plainsong's architecture, not a comparison claim:

- Local transcription is the default.
- Dictation audio uses a temporary file and is removed after processing,
  unless you turn on "Keep dictation audio for Process again"; then each
  dictation keeps its audio until you delete its history entry.
- When you stop a dictation, its audio is also written to one private file
  (readable only by your account, outside recordings, backups and support
  bundles) until the result is recorded. If Plainsong closes before then, the
  next launch offers "Recover last dictation"; Copy or Discard deletes it, and
  it is deleted unseen after 24 hours.
- On macOS, meetings capture WAV audio at the device rate. After the transcript
  and final speaker processing finish successfully, an idle worker stores the
  mic and call tracks as compact 16 kHz, 16-bit FLAC and removes the stored mix.
  Playback rebuilds the mix locally. Existing finalized meetings use the same
  resumable conversion. Pending, failed and incomplete meetings keep full-rate
  audio for retries. A failed conversion keeps the source. Saved transcripts
  never change during conversion. Re-transcribing or relabeling speakers in an
  older meeting uses its compact 16 kHz audio, so results can differ slightly
  from the original. Kept dictations retain native-rate FLAC. Vault recordings
  remain encrypted. Settings counts stored audio and completed space savings.
- Dictation during a recorded meeting keeps its own audio in the same private
  recovery storage, including during a meeting pause or with another dictation
  microphone. The 24-hour limit applies even with History off.
  These asides keep their text outside meeting transcripts, notes,
  search, Ask and searchable dictation history. Review can reveal or delete
  their separate text. Deleting text keeps its audio mask so re-transcription
  cannot restore it. Mic-only audio exports silence aside spans, including
  FLAC recordings. Me + Them mixes omit the microphone during each aside.
  People on the call can still hear you; a first-use notice says so.
- The proposed meeting audio retention is three months, with transcripts and
  notes kept. Automatic deletion stays paused until you confirm it in Settings,
  including for existing audio. Existing durations and delete modes remain,
  but their timers pause until you confirm.
  You can choose never, one week, a month-based limit, or transcript-only
  storage. Active, pending, recovery and unacknowledged incomplete transcripts
  keep their audio. "Free up space now" confirms deletion of eligible old audio
  while retaining transcripts and notes.
- Remote transcription, analysis, and cloud backup require an explicit user
  choice.
- Provider credentials use the operating system's secure credential store.
- Plainsong does not create public sharing links or upload local content to a
  Plainsong-operated service.
- The MIT-licensed source is available for inspection.

Competitor behavior changes and is outside this privacy contract. Public
comparison claims should be sourced and re-verified separately for each
release.

## Where your data lives

On your machine:

- **Recordings, transcripts, and meeting notes** are stored in a local database
  and files under the app's data directory.
- **Settings** are stored in a local config file.
- **API keys and internal secrets** use the operating system's keychain or
  credential manager. ChatGPT account records use encrypted local storage as
  described below.

If you enable **Save notes to a folder** in Settings > Meetings, Plainsong
writes Markdown notes and, if selected, transcripts to the folder you choose
through the native picker. These copies are readable text outside the vault.
Your folder's sync service may upload them under its own settings. Plainsong
makes no network request to publish them. Deleting a meeting keeps its
published file unless you explicitly choose to delete that copy too.

You can delete this data at any time by removing recordings in the app or
deleting the app's data directory. Retention is under your control; Plainsong
does not automatically upload or sync anything.

## When data does leave your machine (only if you choose)

Plainsong supports optional **bring-your-own-key (BYOK)** cloud providers for
transcription and AI cleanup, such as OpenAI, Anthropic, Mistral,
ElevenLabs, or Groq. These are off by default. If you select one:

- The relevant audio or text is sent **directly from your machine to that
  provider**, authenticated with **your own API key**, and billed to you.
- It is **not** proxied through any Plainsong server.
- That provider's privacy policy and data-handling then apply to what you send.

Similarly, optional local AI analysis uses [Ollama](https://ollama.com) running
on your own machine, and optional cloud backup uses **your own** storage
such as an rclone remote or iCloud path. You choose the destination and credentials.

The app labels which path is local and which is cloud so you always know where a
given request is going.

### ChatGPT sign-in

ChatGPT plan access is an optional text route using OAuth with OpenAI. It
requires cloud processing to be enabled and an explicit account action.
Plainsong opens OpenAI's authorization page in your browser. That request sends
a locally generated persistent host identifier, a client identifier, the
Plainsong app name for a new registration, a local callback address, requested
scopes, and OAuth state, nonce and PKCE challenge values. A returning account
can also send its saved email as a login hint and its identity token as an
account hint. The scopes request identity, profile, email, offline access and
permission to use ChatGPT plan tokens. Your browser's OpenAI sign-in session is
handled by OpenAI, not by Plainsong.

The authorization code and PKCE verifier are exchanged directly with OpenAI
for tokens. Text requests and model-list requests use the account's access
token. When it expires, Plainsong can send the refresh token and client
identifier to OpenAI to obtain a new one. Signing out clears local credentials
and, while cloud processing is enabled, attempts remote revocation using
OpenAI's discovery and revocation endpoints. The app reports whether revocation
was confirmed; local sign-out does not guarantee remote revocation.

Plainsong stores the host identifier, saved account hints, registration data
and tokens in an encrypted `chatgpt-accounts` file under its app data directory.
Electron safeStorage encrypts this file using operating system protection. On
macOS that protection uses the Keychain. There is no plaintext fallback.
Recordings and transcripts are not part of this account file. Choosing this
text route sends the requested text directly to OpenAI; it does not enable
ChatGPT audio transcription.

### Gemini audio uploads

If you choose Gemini for transcription, Plainsong uploads the requested audio
to Google's Files API as a temporary file, waits for it to become ready, and
passes its URI to the transcription request. It attempts to delete the uploaded
file after success or failure. If processing is cancelled, cleanup attempts
continue in the background. If the upload response does not identify the file,
or deletion fails, Plainsong reports that cleanup could not be confirmed.
Google's Files API expires uploaded files after 48 hours; you can also remove
them through Google AI Studio. Closing the app or losing connectivity can
prevent immediate cleanup. This remote lifecycle is separate from your local
audio retention settings.

### Apple Speech on-device transcription

On supported Apple Silicon Macs, Apple Speech is an optional on-device
provider. Plainsong makes it selectable only after the packaged helper is present,
Speech Recognition permission is authorized, the requested locale is supported,
and macOS reports on-device recognition and the recognizer itself as available.
Both file and internal streaming requests set `requiresOnDeviceRecognition` to
`true`; Apple server fallback is disabled. If any readiness check fails, Plainsong
reports the specific status and does not silently substitute Whisper or another
provider. Where macOS 26 or later provides Apple's SpeechAnalyzer engine with
the language's speech assets installed, Apple Speech can also transcribe
meetings you choose it for, still on your Mac, and Plainsong adds speaker
labels locally. Otherwise it is dictation-only.

## Calendar access

Connecting your calendar is optional and requires a click in Plainsong followed
by the macOS calendar permission decision. The read-only EventKit helper reads
calendar and account names, event identifiers, titles, start and end times,
conference URLs, and attendee names and email addresses, including organizer and
current-user flags when available. It scans event notes and locations for URLs
but strips the notes and location text from its output. Plainsong does not
create, edit or delete calendar events.

While a calendar view is mounted, macOS access is authorized and the calendar
is connected in Plainsong, Plainsong checks its snapshot every 20 seconds. The
main process caches snapshots for 60 seconds, unless you force a refresh. It
normally looks eight hours ahead, with at most 50 events. Turning off "Suggest
meetings from your calendar" disconnects the calendar: Plainsong stops checking
and reading it and drops the snapshot it held, until you turn it back on. The
choice is saved in Plainsong's settings. It does not revoke the macOS
permission; do that in System Settings.

Snapshots stay in memory. Starting a recording from a calendar cue saves the
chosen title, attendee names and emails, and conferencing service with that
recording in the local database. Calendar preferences, such as hidden calendars
and dismissed events, are stored locally. The event title and attendee names
can enter a pre-meeting brief or meeting analysis through the AI route you
choose, including a cloud provider. Attendee email addresses are used for local
matching and are removed from the model context. Joining a conference opens
the selected URL in your browser or meeting app, which then contacts that
service under its own policies.

## Spelling from nearby text

"Spell names from nearby text" in Settings > Dictation is off by default and
requires macOS Accessibility permission. At dictation start, a background reader
checks the original target window's visible labels, recipient fields, title and
accessible text. It does not take screenshots, use OCR or touch the clipboard.
Password managers, system password windows, secure fields and hidden elements
are skipped. Apps that do not expose their visible text may supply no vocabulary.

The reader stops at 64 elements, 4,000 characters or a 30 ms read deadline. It
extracts at most 50 names, email-derived names, product spellings and identifiers
on this Mac, then drops the raw text. The vocabulary belongs to that dictation
and is discarded when it ends. It is never saved in history, learned into your
word list, or supplied as context to speech or text providers. On the local
Parakeet route, the on-device speech model also checks the dictation's audio
against these words, on this Mac.

Correction changes only close matches to words already transcribed. Short and
ambiguous names and ordinary English words stay unchanged. In code editors, exact spoken
identifier components can become their visible spelling. The original transcript
and resulting changes remain available in the existing change review. The
corrected transcript follows your normal history and AI-cleanup choices, so a
spelling actually applied to your words can appear in history or reach your
chosen cloud cleanup provider. Unused screen vocabulary cannot.

## Spelling names from calendar and Contacts

"Use names from my calendar and contacts to spell names" in Settings > Dictation
has separate Calendar and Contacts switches. Both are off by default. Each
switch requests its own macOS permission only when you turn it on. Neither
source requests permission at launch.

Calendar spelling reads attendee and organizer display names from the past
seven days and next two days. Its helper returns only names and event times,
never addresses, titles, notes or conference links. Dictation favors today's
attendees, then frequent and recent attendees. Meetings favor the current or
next event. The names refresh with the calendar's one-minute polling interval.
Disconnecting the calendar stops these reads and clears its spelling hints.
The separate calendar meeting feature can still save attendees when you choose
to start a meeting from a calendar event. Spelling adds no saved attendee list.

Contacts reads given names, family names and nicknames, at most 2,000, without
recording which contact a word came from. It never reads phone numbers, email
addresses, postal addresses, notes or photos, and never changes Contacts.
Contacts does not expose contact frequency or recent use through this reader.
Its list refreshes when enabled, when the background process restarts, and
every 30 minutes while enabled. Unusual spellings rank first.

Both spelling lists stay in memory on this Mac. Plainsong never writes them to
disk, settings, history, logs or support bundles, or sends the lists to a cloud
provider. Only the switches are saved. Each local speech request can use up to
150 calendar terms and 250 Contacts terms within the shared 500-term vocabulary.
Turning a source off clears its list. A permission refusal clears that source
on its next check. Revoke macOS access in System Settings > Privacy & Security >
Calendars or Contacts. A name you actually say becomes transcript text and
follows your selected transcription and cleanup settings.

A name is applied only when the recognizer wrote an unfamiliar word that closely
matches it and the audio supports it; ordinary words, numbers and negations are
never changed. The original transcript stays in the change review. As with
nearby spelling, a name actually applied to your words becomes part of the
transcript and follows your normal history and AI-cleanup choices.

## Learning from corrections in other apps

This is off by default. If you turn it on, Plainsong uses Accessibility to read
the text field it just typed into for up to eight seconds. Those reads can
include surrounding text in that field. Switching apps or fields stops the
checks. Some apps allow only one check after four seconds.

Plainsong compares the text locally and saves only word changes as suggestions.
You review and approve a suggestion before it changes your dictionary.
Unreviewed suggestions expire after a week.

## Permissions

- **Microphone.** Required to capture audio for dictation and meetings.
- **Speech Recognition, optional.** Required only when you explicitly choose
  Apple Speech for on-device dictation.
- **Calendars, optional.** Reads upcoming meetings and invitees as described
  above. Plainsong does not change your calendar.
- **Contacts, optional.** Reads only names, to spell people's names in
  dictation, as described above. Plainsong does not change your contacts.
- **Accessibility.** Required to insert transcribed text into other apps. Also
  used for nearby spelling when you enable it, as described above.
- **Screen & System Audio Recording, optional.** Used only for Me + Them
  meetings, to record the meeting audio playing on your Mac (the other people
  on the call), including when you wear headphones. Plainsong asks for it only
  when you choose to set up meeting audio. macOS shows it under Privacy &
  Security → Screen & System Audio Recording; Plainsong asks only for audio
  and never records your screen. While a Me + Them meeting is recording,
  Plainsong hears everything the Mac plays, not only the meeting app, so a
  notification sound or a video playing at the same time can end up in the
  recording. The microphone and the meeting audio are kept as two separate
  tracks of that meeting and are stored and transcribed like the rest of the
  recording. No audio driver is installed for this.

These are standard OS permissions you grant explicitly and can revoke at any
time in System Settings.

## Verifying these claims

This is open-source software. If you want to confirm any of the above, start
with `nautilus-bot/rust-sidecar/src/download/mod.rs` (model and VAD downloads),
`nautilus-bot/rust-sidecar/src/asr/` and `nautilus-bot/rust-sidecar/src/llm/`
(transcription and AI providers), `nautilus-bot/electron/main.ts` and
`nautilus-bot/electron/updater-channel.ts` (manual update checks), and
`nautilus-bot/rust-sidecar/src/backup.rs` (optional rclone backup). Provider
command wiring is in `nautilus-bot/rust-sidecar/src/lib.rs`, and secret handling
is in `nautilus-bot/rust-sidecar/src/secrets.rs`. There is no hidden network
layer.
