# Modular Onboarding Design

## Goal

Replace the current one-shot onboarding wizard with a modular setup system that:

- gets first-run users to a successful dictation-ready state quickly
- treats meeting setup as optional on day one
- gives users a clear way to come back later and configure meetings
- keeps onboarding useful after first launch instead of being a disposable modal

## Product Shape

The onboarding system will support three entry modes:

- `full`: first-run guided setup
- `dictation`: focused dictation readiness module
- `meetings`: focused meeting setup module

First-run behavior will use `full` mode. That flow should prioritize dictation readiness and only continue into meeting setup if the user explicitly chooses it.

## First-Run Flow

The first-run flow will become:

1. Welcome / focus choice
2. Dictation permissions and install readiness
3. Dictation model / route setup
4. Dictation hotkey and usage basics
5. Optional meeting setup handoff

At the meeting handoff, users can either:

- finish onboarding with dictation only
- continue into the meeting setup module immediately

Completing the dictation path should mark onboarding complete. Meeting setup should remain available later from Settings.

## Dictation Module

The dictation module should verify and guide:

- running from `/Applications` instead of the DMG copy
- microphone permission
- speech recognition permission where applicable
- accessibility / cursor insert readiness
- dictation model or route readiness
- hotkey behavior and shortcut configuration

The copy should emphasize a successful first dictation outcome, not just toggles.

## Meeting Module

The meeting module should verify and guide:

- meeting-capable ASR route
- system audio availability
- loopback/BlackHole presence when needed
- mic-only fallback if system audio is unavailable
- meeting storage/privacy defaults

The module should explain clearly when meetings are ready, when they are mic-only, and when system audio still needs setup.

## Re-entry

Settings will expose three reusable entry points:

- `Rerun onboarding`
- `Fix dictation setup`
- `Set up meetings`

These entry points should reopen the wizard in the appropriate mode without requiring an app reset.

## State

Keep the existing onboarding completion key for first-run completion.

Add a separate meeting-setup completion key so the app can remember whether the optional meeting module has been completed, without blocking first-run completion.

## Error Handling

Onboarding steps should not fail silently. Each step should end in one of:

- ready
- actionable warning
- skipped intentionally

For meetings, the guidance should prefer precise setup language such as:

- `System audio capture is not available yet`
- `This meeting model is not suitable for meetings`
- `Mic-only meetings are available right now`

## Testing

Add coverage for:

- first-run full flow finishing after dictation only
- first-run full flow continuing into meetings
- meeting-only mode surfacing system audio readiness
- dictation-only mode avoiding meeting steps
- settings-triggered onboarding reopen behavior
