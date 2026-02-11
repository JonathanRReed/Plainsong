# Packaged App QA Matrix (macOS)

## Scope
- Validate dictation/meeting parity behaviors against Superwhisper and Granola expectations.
- Validate provider truthfulness (`requested_provider` vs `actual_provider`) for Whisper, Parakeet, Distil Whisper, and Canary.
- Validate popup resilience when the main window is hidden/minimized.

## Build Under Test
- Date: `2026-02-11`
- App build: `npm run tauri build`
- macOS version:
- Hardware:

## Permissions Prerequisites
- Microphone granted to Nautilus.
- Accessibility granted to Nautilus.
- Confirm diagnostics in Settings show:
  - `Microphone: Ready`
  - `Accessibility: Ready`
  - `Automation: Ready` (or copied-only fallback message is shown)

## Functional Matrix

| Area | Scenario | Expected |
|---|---|---|
| Dictation hotkey | Hold `Ctrl+Shift+Space` 2-5s, release | Stops within 500ms, phase transitions `recording -> stopping -> transcribing -> done/error` |
| Dictation failsafe | Hold hotkey, then trigger `Ctrl+Shift+Escape` | Capture force-stops and session recovers to `idle` |
| Dictation paste | Focus external app text field and run dictation | Text is pasted; if blocked, copied-only status with remediation text |
| Popup resilience | Start dictation, hide main app window | Dictation popup remains visible and operable (`Stop`, `Hide`, `Open app`) |
| Meeting popup | Start meeting capture, hide main app | Recording popup remains visible with timer + waveform + stop action |
| Provider truth | Set provider to Parakeet, transcribe | Metadata reports `requested=parakeet`, `actual=parakeet`, `fallback_used=false` |
| Provider truth | Set provider to Distil, transcribe | Metadata reports `requested=distil_whisper`, `actual=distil_whisper`, `fallback_used=false` |
| Provider truth | Set provider to Canary, transcribe | Metadata reports `requested=canary`, `actual=canary`, `fallback_used=false` |
| Fallback policy | Disable `allowWhisperFallback`, break selected provider runtime | Provider-specific error shown; no silent Whisper substitution |
| Fallback opt-in | Enable `allowWhisperFallback`, break selected provider runtime | Result metadata reports `actual=whisper`, `fallback_used=true`, with reason |

## Model Runtime Readiness

| Provider | Download complete | Runtime ready | Selectable |
|---|---|---|---|
| Whisper | ggml model exists | N/A (native Rust runtime) | Yes |
| Parakeet | `.nemo` exists | `python3` + `nemo.collections.asr` available | Yes |
| Distil Whisper | required HF files in `models/distil_whisper` | `python3` + `torch` + `transformers` available | Yes |
| Canary | required HF files in `models/canary` | `python3` + `torch` + `transformers` available | Yes |

## Regression Notes
- If hotkey appears stuck in `recording`, capture logs and verify release event + watchdog path.
- If app opens blank, capture frontend console + Tauri logs for route/window creation errors.
- If external paste fails in dev, verify packaged build behavior before marking bug (dev apps often have permission edge cases).
