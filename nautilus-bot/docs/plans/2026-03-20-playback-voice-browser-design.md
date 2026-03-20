# Playback Voice Browser Design

Date: 2026-03-20

## Goal

Add a lightweight playback layer to Nautilus that feels integrated into dictation and meetings rather than becoming a separate product surface.

This is a secondary feature:

- dictation first
- meetings second
- playback / screen-reader-style utility third

## Product Shape

Playback should help users hear text back quickly:

- latest dictation result
- selected text where the current surface allows safe capture
- saved dictations
- meeting summaries and follow-up drafts

Playback is not a voice studio, cloning product, or narration workflow.

## UX Model

Use one unified voice browser:

1. choose `Local` or `Cloud`
2. choose provider
3. choose voice
4. adjust small controls like speed and supported provider options

### Local

- System voice
- Piper
- Kokoro
- Kitten

### Cloud

- ElevenLabs
- OpenAI

## Defaults

- default lane: `Local`
- default provider: `System voice`
- playback should work immediately without model downloads
- cloud voices are optional and clearly remote

## Integration Points

- dictation popup `Read aloud`
- latest dictation result
- dictation history dialog
- meeting summary and follow-up surfaces
- selected-text helper where Nautilus already has a safe text-capture path

## Architecture

- frontend owns voice browser state and playback controls
- backend owns provider normalization, model inventory, download state, and cloud playback calls
- selected-text playback should reuse existing safe capture helpers already used by dictation context capture

## First Slice

- write playback design and implementation plan
- reuse the current browser/system voice path as the zero-download local fallback
- add selected-text playback using the existing selection-capture helper
- extend read-aloud entry points into meeting surfaces
- keep provider settings internal until they map to real runtime behavior

## Deferred

- exporting narrated audio files
- voice cloning
- provider-specific deep tuning surfaces
- sync of local voice assets
- giant standalone playback feature area

## Success Bar

- playback feels like a polished built-in convenience feature
- selected text can be read back where safe
- local-first remains the default
- future provider work can land on a clean settings/runtime contract
