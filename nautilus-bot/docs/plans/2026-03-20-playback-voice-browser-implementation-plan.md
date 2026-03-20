# Playback Voice Browser Implementation Plan

Date: 2026-03-20

## Objective

Ship the first practical playback slice without exposing fake provider controls.

## Phase 1

1. Add selected-text playback support using the existing safe selection-capture path.
2. Expose read-aloud in meeting review surfaces alongside dictation surfaces.
3. Keep local browser/system voice as the working playback engine.
4. Add tests for selected-text capture and playback entry points.

## Phase 2

1. Add a persisted playback settings contract:
   - lane: local or cloud
   - provider
   - voice id
   - playback speed
   - provider options map
2. Add a compact playback section to settings.
3. Wire system voice playback to those settings.

## Phase 3

1. Add real cloud playback providers:
   - ElevenLabs
   - OpenAI
2. Add readiness checks based on stored API keys.
3. Keep cloud clearly marked as remote processing.

## Phase 4

1. Add real local model providers:
   - Piper
   - Kokoro
   - Kitten
2. Reuse the existing model download and inventory patterns where possible.
3. Only surface download/install controls once runtime behavior is real.

## Validation

- targeted frontend tests for popup, dictation view, and meetings
- backend tests for selected-text capture command
- full `npm test`
- `npm run build`
- Rust tests when backend commands change
