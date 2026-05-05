# shadcn Registry UI Opportunities

Checked: 2026-05-05

## Executive Read

Nautilus already has a usable shadcn base: Vite, React, Tailwind 4, `base-nova`, lucide icons, and the `@magicui` namespace. The best path is selective adoption, not a theme or preset replacement.

The highest-value registry targets are:

1. ElevenLabs UI `waveform`, for recording, processing, and playback visualization.
2. AI Elements `transcription`, for time-aware transcript segments.
3. AI Elements `prompt-input`, for meeting chat, saved recipes, and follow-up drafting.
4. AI Elements `model-selector`, adapted into provider and ASR route selection.
5. ElevenLabs UI `audio-player`, only if the existing player cannot meet playback QA.

Avoid broad install-all commands. Registry items can bring dependencies, generated paths, and browser APIs that are not automatically safe for an Electron desktop app.

## Current Project Fit

Local shadcn context:

- Framework: Vite
- React server components: false
- Tailwind: v4
- Style: `base-nova`
- Base primitive style: `base`
- Icons: lucide
- UI alias: `@/components/ui`
- Existing registry namespace: `@magicui`
- Existing installed UI components: `badge`, `button`, `card`, `command`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`, `progress`, `scroll-area`, `select`, `separator`, `switch`, `tabs`, `textarea`, `tooltip`

This is compatible with shadcn registry installs, but third-party components still need review after install because many examples hardcode paths such as `@/registry/default/ui/...`.

## Registry Sources Checked

Official shadcn:

- shadcn registry index docs say registry items can be searched, viewed, and added, including namespaced items such as `@ai-elements/prompt-input`.
- shadcn MCP docs confirm the MCP and CLI model supports browsing, searching, installing, and multiple registries configured through `components.json`.
- shadcn registry docs describe `view` as the safe inspection step before installation, including dependencies, files, CSS, and environment variables.

Registry discovery:

- `registry.directory` lists AI Elements as an AI-native component registry with conversations and messages.
- `registry.directory` lists ElevenLabs UI as a collection for agent and audio applications, including orbs, waveforms, voice agents, audio players, and more.

ElevenLabs UI:

- ElevenLabs UI docs describe it as a custom registry built on top of shadcn/ui for multimodal agentic experiences.
- ElevenLabs UI component docs show `waveform` includes `Waveform`, `AudioScrubber`, `LiveMicrophoneWaveform`, `MicrophoneWaveform`, `RecordingWaveform`, `ScrollingWaveform`, and `StaticWaveform`.
- ElevenLabs UI GitHub docs show shadcn-compatible direct install URLs such as `https://ui.elevenlabs.io/r/waveform.json` and `https://ui.elevenlabs.io/r/all.json`.

## Candidate Matrix

| Candidate | Source | Fit | Dependencies observed | Recommendation |
| --- | --- | --- | --- | --- |
| ElevenLabs UI `waveform` | `https://ui.elevenlabs.io/r/waveform.json` | Dictation popup, meeting recording state, processing state, playback scrubber | none in registry item | Build first, but adapt into existing `audio-waveform.tsx` or a dedicated wrapper instead of blindly replacing current UI. |
| AI Elements `transcription` | `@ai-elements/transcription` | Meeting transcript with active segment and seek support | `ai`, `@radix-ui/react-use-controllable-state` | Monitor or adapt manually. It depends on Vercel AI SDK types, which is unnecessary if Nautilus already has transcript segment types. |
| AI Elements `prompt-input` | `@ai-elements/prompt-input` | Granola-style meeting chat, saved recipes, follow-up draft input, command palette-like prompt composition | `ai`, `lucide-react`, `nanoid`; registry deps include `hover-card`, `input-group`, `spinner` | Useful design reference. Do not install until we decide whether to add `ai`, `nanoid`, `hover-card`, `input-group`, and `spinner`. |
| AI Elements `model-selector` | `@ai-elements/model-selector` | ASR and LLM provider picker, provider integrity telemetry, route selection | registry deps `command`, `dialog`; remote logos from `models.dev` | Good local adaptation candidate. Remove remote logos or bundle provider icons locally before production. |
| AI Elements `audio-player` | `@ai-elements/audio-player` | Meeting playback controls, generated speech preview | `ai`, `media-chrome`; registry dep `button-group` | Avoid for now unless current playback UI fails QA. Adds `media-chrome` and Vercel AI SDK dependency. |
| AI Elements `speech-input` | `@ai-elements/speech-input` | Dictation record button inspiration | `lucide-react`; registry deps `button`, `spinner` | Avoid direct use. It relies on browser Web Speech and MediaRecorder flows, while Nautilus should use the native sidecar capture and ASR pipeline. |
| ElevenLabs UI `audio-player` | `https://ui.elevenlabs.io/r/audio-player.json` | Rich playback control and speed controls | `@radix-ui/react-slider`, `@radix-ui/react-dropdown-menu` | Better fit than AI Elements audio player because it avoids `ai` and `media-chrome`, but it adds slider. Consider only if playback QA needs richer controls. |
| ElevenLabs UI `transcript-viewer` | `https://ui.elevenlabs.io/r/transcript-viewer.json` | Word-level audio-aligned transcript | dev dep `@elevenlabs/elevenlabs-js`; registry dep `scrub-bar` | Avoid direct install for launch. It is shaped around ElevenLabs character alignment models, not Nautilus transcript artifacts. |
| Magic UI `animated-gradient-text` | already installed locally | Brand/polish text accent | already present | Keep usage restrained. Not launch-critical. |
| Magic UI `terminal` | `@magicui/terminal` | Release doctor, provider route log, QA evidence preview | unknown until deeper view | Possible later. Prefer the existing delivery doctor first. |

## Best Launch-Critical Uses

### 1. Recording and Processing Waveform

Add or adapt ElevenLabs `waveform` into:

- dictation popup listening state
- meeting recording overlay
- recording detail playback
- processing state after stop

Why it helps:

- Improves user trust that capture is active.
- Supports the release plan item that consent, recording state, processing state, transcript refresh, and export status must be unmistakable.
- Can improve packaged UX evidence without changing ASR behavior.

Risk:

- Browser microphone variants in the component should not own capture. Nautilus should pass known local audio levels or state into the visualization.

### 2. Provider and Route Selector

Adapt AI Elements `model-selector` patterns into the existing ASR route/provider UI.

Use it for:

- local versus cloud ASR selection
- BYOK provider selection
- route status and fallback visibility
- provider integrity mismatch explanation

Production change required:

- Do not load remote provider logos from `models.dev`.
- Keep selected route, actual route, fallback reason, and latency visible in the app.

### 3. Meeting Chat and Recipes Input

Use AI Elements `prompt-input` as a design reference for:

- meeting chat
- saved prompt recipes
- follow-up drafts
- decision and deadline extraction prompts

Direct install is not recommended yet because it pulls in Vercel AI SDK types and extra registry UI components.

### 4. Time-Aware Transcript Segments

Use AI Elements `transcription` as a reference for active segment styling and seek behavior.

Direct install is not ideal because Nautilus already has transcript types and does not need `Experimental_TranscriptionResult` from `ai`.

### 5. Playback Controls

Consider ElevenLabs `audio-player` only if existing playback controls are not enough for QA.

Use it for:

- speed controls
- buffering state
- scrub behavior
- accessible play and pause controls

Risk:

- It adds `@radix-ui/react-slider`. That is acceptable only if playback QA needs it and the dependency is explicitly approved.

## Suggested Implementation Order

1. Create a local `RecordingSignal` wrapper inspired by ElevenLabs `waveform`, wired to Nautilus recording state instead of direct browser mic access.
2. Add a `TranscriptTimeline` local component inspired by AI Elements `transcription`, using Nautilus transcript segment data.
3. Refactor provider/route selection toward a `CommandDialog` selector, based on the AI Elements `model-selector` pattern.
4. Add a compact `RecipePromptInput` only after deciding whether to install `input-group`, `hover-card`, and `spinner` from shadcn.
5. Revisit audio player replacement only after playback QA shows a real gap.

## Components To Avoid For This Release

- ElevenLabs `all`, because install-all is too broad for a release candidate.
- AI Elements `speech-input`, because it would bypass Nautilus native capture and ASR routing.
- AI Elements `audio-player`, because it adds both `ai` and `media-chrome`.
- ElevenLabs `transcript-viewer`, because it is tied to ElevenLabs character alignment shapes.
- Decorative Magic UI effects such as sparkles, spinning text, particles, and globe. They do not help launch blockers.

## Guardrails

- Run `shadcn view` before every install.
- Use `shadcn add --dry-run` or `--diff` before overwriting existing UI files.
- Review added files for hardcoded aliases and unsupported registry paths.
- Do not add production dependencies without explicit approval.
- Do not let browser mic components own capture in Electron.
- Keep all AI and cloud-provider UI honest about local-first versus BYOK cloud behavior.

## Source URLs

- shadcn registry index: https://ui.shadcn.com/docs/changelog/2025-09-registry-index
- shadcn MCP and registry configuration: https://ui.shadcn.com/docs/mcp
- shadcn components config: https://ui.shadcn.com/docs/components-json
- registry.directory: https://registry.directory/
- ElevenLabs UI docs: https://ui.elevenlabs.io/docs
- ElevenLabs waveform docs: https://ui.elevenlabs.io/docs/components/waveform
- ElevenLabs UI GitHub: https://github.com/elevenlabs/ui
