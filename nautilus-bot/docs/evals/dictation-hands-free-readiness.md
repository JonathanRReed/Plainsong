# Dictation Hands-Free Readiness

Generated: 2026-04-09T16:08:48.649Z

Hands-free remains a launch-critical trust path. The repo now has explicit local evidence for implementation coverage, but not yet packaged long-session evidence.

## Automated coverage

- [first-run-wizard.test.tsx](/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/__tests__/first-run-wizard.test.tsx) covers onboarding persistence for hands-free mode.
- [dictation-popup.test.tsx](/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/__tests__/dictation-popup.test.tsx) covers popup guidance when hands-free mode is enabled.
- [dictation-view.tsx](/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/dictation-view.tsx) and [settings-view-simple.tsx](/Users/jonathanreed/Downloads/NautilusBot/nautilus-bot/src/components/views/settings-view-simple.tsx) expose runtime settings and explanation copy.

## Current launch state

- Local implementation coverage: PASS
- Packaged long-session evidence: BLOCKED
- Required next evidence: packaged start, stop, silence timeout, and recovery capture on macOS and Windows
