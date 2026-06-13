# Privacy

Nautilus is local-first. This document describes, plainly, what happens to your
audio and text. The code is open — you can verify all of it.

## The short version

- **By default, your audio is transcribed on your machine** and never leaves it.
- **There is no telemetry or analytics.** Nautilus does not phone home, count
  usage, or report crashes anywhere. (Verified: no analytics/telemetry SDKs in
  the codebase.)
- **There are no Nautilus servers.** We don't host an API, an account system, or
  cloud storage. There is nothing for us to collect because there is nowhere for
  it to go.
- **We never capture your screen.** Nautilus does not screenshot the active
  window or read other apps' contents to "add context."

## Where your data lives

On your machine:

- **Recordings, transcripts, and meeting notes** are stored in a local database
  and files under the app's data directory.
- **Settings** are stored in a local config file.
- **API keys and internal secrets** are stored in the operating system's
  keychain / credential manager — not in plaintext.

You can delete this data at any time by removing recordings in the app or
deleting the app's data directory. Retention is under your control; Nautilus
does not automatically upload or sync anything.

## When data does leave your machine (only if you choose)

Nautilus supports optional **bring-your-own-key (BYOK)** cloud providers for
transcription and AI cleanup — for example OpenAI, Anthropic, Mistral,
ElevenLabs, or Groq. These are off by default. If you select one:

- The relevant audio or text is sent **directly from your machine to that
  provider**, authenticated with **your own API key**, and billed to you.
- It is **not** proxied through any Nautilus server.
- That provider's privacy policy and data-handling then apply to what you send.

Similarly, optional local AI analysis uses [Ollama](https://ollama.com) running
on your own machine, and optional cloud backup uses **your own** storage
(e.g. an rclone remote or iCloud path) — your cloud, your credentials.

The app labels which path is local and which is cloud so you always know where a
given request is going.

## Permissions

- **Microphone** — required to capture audio for dictation and meetings.
- **Accessibility** — required to insert transcribed text into other apps.
- **Screen/System audio** (optional) — only used to record system audio for
  meetings when you enable it.

These are standard OS permissions you grant explicitly and can revoke at any
time in System Settings.

## Verifying these claims

This is open-source software. If you want to confirm any of the above, the
network-touching code is in `nautilus-bot/rust-sidecar/src/llm/` (cloud LLM
clients) and `nautilus-bot/rust-sidecar/src/asr/` (transcription providers), and
secret handling is in `nautilus-bot/rust-sidecar/src/secrets.rs`. There is no
hidden network layer.
