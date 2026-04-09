# Competitor Claim Snapshot (2026-04-09)

This file is a date-stamped baseline snapshot used by the parity audit and launch scorecards.

## Sources

- Superwhisper homepage: [superwhisper homepage](https://superwhisper.com/)
- Superwhisper keyboard shortcuts: [superwhisper shortcuts](https://superwhisper.com/docs/get-started/settings-shortcuts)
- Superwhisper advanced settings: [superwhisper advanced settings](https://superwhisper.com/docs/get-started/settings-advanced)
- Superwhisper history reprocessing: [superwhisper history](https://superwhisper.com/docs/get-started/transcribe-history)
- Superwhisper Windows support: [superwhisper windows](https://superwhisper.com/docs/get-started/windows)
- Superwhisper changelog: [superwhisper changelog](https://ai.superwhisper.com/changelog)
- Granola multilingual support: [granola multi-language](https://docs.granola.ai/en/articles/10298950-multi-language-support)
- Granola supported meeting apps: [granola meeting apps](https://docs.granola.ai/en/articles/9576388-supported-meeting-apps)
- Granola platform support: [granola iOS + desktop](https://docs.granola.ai/en/articles/10322795-ios-app-notes-compatibility-and-syncing)

## Qualitative Claims

- Superwhisper currently markets fast voice-to-text in any app, custom modes, context-aware processing, push-to-talk and mouse shortcut controls, mini recording window controls, history reprocessing, file transcription, system audio capture, own-API-key configuration, and 100+ languages.
- Superwhisper documents that Windows still lags macOS for file sync, speaker separation, local language models, realtime transcription, mouse button shortcuts, automatic microphone gain, and restore-clipboard behavior.
- Granola continues to position around bot-free meeting capture, multilingual support, synced desktop and mobile workflows, and transcript-centric meeting assistance.

## Numeric Claims

- Superwhisper publicly advertises support for `100+` languages and dialects.

## Machine-Readable Claims

```json
{
  "snapshotDate": "2026-04-09",
  "numericClaims": [
    {
      "id": "superwhisper-language-breadth",
      "capabilityKey": "superwhisper-language-breadth",
      "tool": "superwhisper",
      "metric": "supported_languages_marketed",
      "claim": "Supports 100+ languages and dialects",
      "value": 100,
      "direction": "at_least"
    }
  ],
  "qualitativeClaims": [
    {
      "id": "superwhisper-fast-dictation",
      "capabilityKey": "superwhisper-fast-dictation",
      "tool": "superwhisper",
      "metric": "dictation_speed_positioning",
      "claim": "Markets fast dictation and shortcut-driven workflows"
    },
    {
      "id": "superwhisper-context-modes",
      "capabilityKey": "superwhisper-context-modes",
      "tool": "superwhisper",
      "metric": "context_mode_positioning",
      "claim": "Markets custom modes with context awareness and app-specific workflows"
    },
    {
      "id": "superwhisper-history-reprocess",
      "capabilityKey": "superwhisper-history-reprocess",
      "tool": "superwhisper",
      "metric": "history_reprocess_positioning",
      "claim": "Markets history review and reprocessing without re-recording"
    },
    {
      "id": "granola-meeting-coverage",
      "capabilityKey": "granola-meeting-coverage",
      "tool": "granola",
      "metric": "meeting_coverage_positioning",
      "claim": "Markets broad meeting-app compatibility and multilingual support"
    }
  ]
}
```

## Baseline Policy

- Qualitative claims are evaluated as binary parity checks.
- Numeric claims, when present, require Nautilus to exceed the claim by at least 10% in the favorable direction, or to narrow launch claims so they stay truthful.
