# Native ASR Selection Design

Date: 2026-03-05

## Goal

Expose Apple native speech and Windows native speech as first-class ASR choices, and let users choose:

- one ASR for everything
- a separate ASR for dictation
- a separate ASR for meetings

The product should fail loudly when a selected native provider is unavailable or missing permissions, and guide the user toward a fix or an alternate provider.

## Decisions

1. Treat `macos_apple_speech` and `windows_sdk_dictation` as normal ASR providers.
2. Keep the existing `defaultProvider` and `selectedModelId` fields as the shared/default route.
3. Add per-mode settings:
   - `useSharedAsrSelection`
   - `dictationProvider`
   - `dictationModelId`
   - `meetingProvider`
   - `meetingModelId`
4. Keep provider-specific model storage in `providerModelIds` so the provider manager remains the single place that tracks downloaded/runtime models.
5. Preserve the existing platform optimization system for advanced engine overrides, but do not require it for Apple/Windows native provider selection.

## Backend Design

### Provider model

Add two new `AsrProviderType` variants:

- `MacosAppleSpeech`
- `WindowsSdkDictation`

Each gets a lightweight provider wrapper that calls the existing platform transcription helpers and reports an OS-managed model.

### Settings normalization

When settings are loaded or saved:

- normalize shared/default provider and model
- normalize dictation and meeting provider/model overrides
- if shared selection is enabled, copy the shared provider/model into both mode-specific fields

### Runtime selection

At dictation transcription time:

- resolve provider/model from `dictation*` fields when split mode is enabled
- otherwise use the shared/default provider/model

At meeting preview and meeting final transcription time:

- resolve provider/model from `meeting*` fields when split mode is enabled
- otherwise use the shared/default provider/model

### Failure behavior

Native providers do not silently fall back.

If Apple native speech or Windows native speech is selected but unavailable:

- startup/runtime checks report the exact reason
- transcription fails with a concrete setup message
- UI should suggest fixing permissions/runtime or choosing another provider

## UI Design

Add a `Transcription Route` card above the provider grid with:

- `Use the same ASR for dictation and meetings`
- shared provider/model selectors when enabled
- separate dictation and meeting provider/model selectors when disabled
- inline readiness/help text for the currently selected route(s)
- direct permission actions for Apple native speech when macOS Speech Recognition is not ready

Hide the existing low-level tooling behind an `Advanced Tools` disclosure by default.

Keep the existing provider cards for power users:

- runtime inspection
- downloads
- model management
- advanced engine diagnostics

## Constraints

- Apple native speech is now a first-class provider route.
- Windows native speech is now a first-class provider route.
- Advanced platform optimization remains available for expert routing, but it is no longer the only path to native speech selection.

## Verification Plan

- Rust unit tests for settings defaults and normalization
- frontend tests covering platform optimization persistence
- existing backend and frontend test suites

## External references

- Apple Speech framework: https://developer.apple.com/documentation/speech
- Apple live audio speech recognition: https://developer.apple.com/documentation/speech/recognizing-speech-in-live-audio
- WWDC25 SpeechAnalyzer session: https://developer.apple.com/videos/play/wwdc2025/277
- Microsoft speech recognition overview: https://learn.microsoft.com/en-us/windows/ai/apis/speech-recognition
