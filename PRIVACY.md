# Privacy

Plainsong is local-first. This document describes, plainly, what happens to your
audio and text. The code is open — you can verify all of it.

## The short version

- **By default, your audio is transcribed on your machine** and never leaves it.
- **There is no telemetry or analytics.** Plainsong does not phone home, count
  usage, or report crashes anywhere. (Verified: no analytics/telemetry SDKs in
  the codebase.)
- **There are no Plainsong servers.** We don't host an API, an account system, or
  cloud storage. There is nothing for us to collect because there is nowhere for
  it to go.
- **We never capture your screen** — no screenshots, ever. Some dictation modes
  can use your clipboard or currently selected text as context for formatting;
  the global default is off, each mode shows which context source (if any) it
  uses, the text is processed locally unless you chose a cloud provider for AI
  cleanup, and it is never persisted.

## What does connect to the network

"No Plainsong servers" is literal, but it would be misleading to leave it there
without naming the built-in downloads and update checks the app can make. They
all go to third parties and are triggered by you:

- **Downloading a speech model.** The first time you use local transcription,
  Plainsong downloads the model you chose from Hugging Face — about 148 MB for
  the default `base.en`. Hugging Face sees that request, and therefore your IP
  address, the same as any other download. It happens once per model. Nothing
  about your audio, transcripts, or usage is included.
- **Downloading optional Silero voice-activity detection.** If you enable the
  higher-accuracy Silero VAD model, Plainsong downloads its ONNX file from
  `raw.githubusercontent.com`. The URL is pinned to an upstream commit and the
  file must match the expected SHA-256 before Plainsong accepts it.
- **Downloading an optional speaker-diarization model.** If you choose speaker
  diarization, Plainsong downloads the selected WeSpeaker ECAPA-TDNN, ResNet34,
  or CAM++ model from Hugging Face. Each URL is pinned to a model revision and
  each file is checked against its expected SHA-256.
- **Checking for updates.** When you ask Plainsong to check for a new version, it
  requests the release manifest from GitHub. There is no automatic check on
  launch and nothing downloads without your say-so.

Everything else — transcription, formatting, meeting analysis with a local model
— runs on your machine with no network access at all. If you opt into a cloud
provider for transcription or AI cleanup, that provider is named at the point you
choose it, and that is the only case where your text or audio leaves the device.

## What local-first means here

Privacy is a property of Plainsong's architecture, not a comparison claim:

- Local transcription is the default.
- Dictation audio uses a temporary file and is removed after processing.
- Meeting audio is saved only according to the storage and retention choices
  shown in the app.
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
- **API keys and internal secrets** are stored in the operating system's
  keychain / credential manager — not in plaintext.

You can delete this data at any time by removing recordings in the app or
deleting the app's data directory. Retention is under your control; Plainsong
does not automatically upload or sync anything.

## When data does leave your machine (only if you choose)

Plainsong supports optional **bring-your-own-key (BYOK)** cloud providers for
transcription and AI cleanup — for example OpenAI, Anthropic, Mistral,
ElevenLabs, or Groq. These are off by default. If you select one:

- The relevant audio or text is sent **directly from your machine to that
  provider**, authenticated with **your own API key**, and billed to you.
- It is **not** proxied through any Plainsong server.
- That provider's privacy policy and data-handling then apply to what you send.

Similarly, optional local AI analysis uses [Ollama](https://ollama.com) running
on your own machine, and optional cloud backup uses **your own** storage
(e.g. an rclone remote or iCloud path) — your cloud, your credentials.

The app labels which path is local and which is cloud so you always know where a
given request is going.

### Apple Speech on-device dictation

On supported Apple Silicon Macs, Apple Speech is an optional **dictation-only**
provider. Plainsong makes it selectable only after the packaged helper is present,
Speech Recognition permission is authorized, the requested locale is supported,
and macOS reports on-device recognition and the recognizer itself as available.
Both file and internal streaming requests set `requiresOnDeviceRecognition` to
`true`; Apple server fallback is disabled. If any readiness check fails, Plainsong
reports the specific status and does not silently substitute Whisper or another
provider. Apple Speech is not used for meeting transcription.

## Permissions

- **Microphone** — required to capture audio for dictation and meetings.
- **Speech Recognition** (optional) — required only when you explicitly choose
  Apple Speech for on-device dictation.
- **Accessibility** — required to insert transcribed text into other apps.
- **Screen/System audio** (optional) — only used to record system audio for
  meetings when you enable it.

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
