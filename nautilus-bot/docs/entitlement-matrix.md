# Entitlement Matrix

Date: 2026-04-09
Status: active

This file captures the current entitlement behavior implemented in the repo.

Primary source:

- `src/hooks/use-license-features.ts`

Relevant UI copy surfaces:

- `src/components/views/settings-view-simple.tsx`
- `src/components/sidebar.tsx`
- `src/components/update/BetaChannelToggle.tsx`

## Tier Behavior

| State | Effective tier | Core access | Cloud sync | Priority support | Theme access | Update access |
| --- | --- | --- | --- | --- | --- | --- |
| No valid license, no active trial | free | locked to free features | no | no | basic | no |
| Active trial | pro | Pro features enabled during trial | no | no | basic | yes |
| Valid Pro license | pro | Pro features enabled | no | no | pro | yes |
| Valid Friends Club license | friends | Pro features enabled | yes | yes | friends | yes |

## Feature Mapping

Implemented feature flags:

- `whisperLargeModel`
- `intelligentPunctuation`
- `autoDiarization`
- `cloudSync`
- `prioritySupport`

Current mapping from code:

- `pro`: `whisperLargeModel`, `intelligentPunctuation`, `autoDiarization`
- `friends_club`: everything in `pro`, plus `cloudSync`, `prioritySupport`
- trial: same feature access as `pro`, except theme access remains `basic`

## Product Copy Constraints

- Do not market cloud sync as available to all paid users. It is Friends Club only in the current code.
- Do not market priority support as available to all paid users. It is Friends Club only in the current code.
- Do not market premium themes as part of the trial. Theme access during trial stays `basic`.
- Trial copy may state that Pro features are available during trial, but should not imply Friends Club-only access.

## Launch Rule

Public pricing and entitlement copy must stay aligned with this file until the underlying feature map changes in code and is revalidated.
