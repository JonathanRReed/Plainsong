# Competitor Claim Snapshot (2026-02-22)

This file is a date-stamped baseline snapshot used by the SOTA scorecard pipeline.

## Sources
- Superwhisper features: [superwhisper features](https://superwhisper.com/docs/getting-started/features)
- Superwhisper changelog: [superwhisper changelog](https://superwhisper.com/docs/updates/changelog)
- Granola multilingual support: [granola multi-language](https://docs.granola.ai/en/articles/10298950-multi-language-support)
- Granola supported meeting apps: [granola meeting apps](https://docs.granola.ai/en/articles/9576388-supported-meeting-apps)
- Granola platform support: [granola iOS + desktop](https://docs.granola.ai/en/articles/10322795-ios-app-notes-compatibility-and-syncing)

## Qualitative Claims
- Superwhisper positions itself as a fast dictation tool with local-first transcription options and broad workflow shortcuts.
- Granola positions itself as a meeting assistant with broad app compatibility, multilingual support, and synced mobile/desktop workflows.

## Numeric Claims
No explicit, stable numeric performance claims were published in the source pages above on 2026-02-22.

## Machine-Readable Claims
```json
{
  "snapshotDate": "2026-02-22",
  "numericClaims": [],
  "qualitativeClaims": [
    {
      "id": "superwhisper-fast-dictation",
      "capabilityKey": "superwhisper-fast-dictation",
      "tool": "superwhisper",
      "metric": "dictation_speed_positioning",
      "claim": "Markets fast dictation and shortcut-driven workflows"
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
- Numeric claims, when present, require Nautilus to exceed the claim by at least 10% in the favorable direction.
