# Superwhisper Parity Audit (2026-04-09)

This audit compares the current public Superwhisper product surface against the Nautilus codebase and launch evidence.

It answers a narrower question than launch readiness:

- Is Nautilus at parity or better on the core interactive dictation workflow?
- Where does Nautilus already exceed Superwhisper?
- Where is Nautilus still behind Superwhisper's marketed surface?

## External Baseline

Sources used for this audit:

- Superwhisper homepage: [https://superwhisper.com/](https://superwhisper.com/)
- Superwhisper keyboard shortcuts: [https://superwhisper.com/docs/get-started/settings-shortcuts](https://superwhisper.com/docs/get-started/settings-shortcuts)
- Superwhisper advanced settings: [https://superwhisper.com/docs/get-started/settings-advanced](https://superwhisper.com/docs/get-started/settings-advanced)
- Superwhisper history reprocessing: [https://superwhisper.com/docs/get-started/transcribe-history](https://superwhisper.com/docs/get-started/transcribe-history)
- Superwhisper Windows feature support: [https://superwhisper.com/docs/get-started/windows](https://superwhisper.com/docs/get-started/windows)
- Superwhisper changelog: [https://ai.superwhisper.com/changelog](https://ai.superwhisper.com/changelog)

## Nautilus Evidence

Primary repo evidence for this comparison:

- `src/components/views/dictation-view.tsx`
- `src/components/popups/dictation-popup.tsx`
- `src/components/views/settings-view-simple.tsx`
- `src/components/views/recordings-view.tsx`
- `src/hooks/use-recording-detail.ts`
- `src/lib/backend.ts`
- `rust-sidecar/src/settings.rs`
- `rust-sidecar/src/lib.rs`
- `rust-sidecar/src/streaming.rs`
- `rust-sidecar/src/backup.rs`
- `rust-sidecar/src/diarization/mod.rs`
- `rust-sidecar/src/asr/platform/windows_foundry.rs`
- `rust-sidecar/src/asr/platform/windows_sdk_dictation.rs`
- `docs/evals/dictation-parity-launch-scorecard.md`
- `docs/evals/dictation-parity-artifact-summary.md`
- `docs/prelaunch-readiness.md`

## Scorecard

Status values:

- `BETTER`
- `PARITY`
- `BEHIND`
- `PARTIAL`

| Capability | Superwhisper public bar | Nautilus repo evidence | Status |
| --- | --- | --- | --- |
| Global hotkey dictation | Keyboard shortcut driven dictation in any app | Global dictation shortcuts, packaged benchmark fixtures, and launch matrix evidence path exist | PARITY |
| Push-to-talk | Publicly documented press-and-hold recording shortcut | `dictation_push_to_talk` runtime setting exists and is wired into dictation flows | PARITY |
| Live partial preview | Public realtime transcription and teleprompter-style preview | Partial streaming pipeline exists and popup/view surfaces expose live partial text | PARITY |
| Mini recording window | Public mini recording window and always-show mode | Dictation and meeting mini window controls exist in settings and popup flows | PARITY |
| Custom modes | Public custom modes for different tasks | Nautilus custom modes persist prompts, base styles, and behavior flags | PARITY |
| Context awareness | Public app and context-aware mode behavior | Nautilus supports app matcher, domain matcher, and application-context-aware styles | PARITY |
| History reprocessing | Public reprocess-from-history workflow | Dictation history preserves recording metadata and supports reprocessing and recovery review | PARITY |
| Restore clipboard after paste | Publicly supported on macOS, explicitly missing on Windows | Clipboard restore-after-paste logic exists in the Rust insertion path, including Windows code path | BETTER |
| Local language models on Windows | Superwhisper documents this as not yet supported on Windows | Nautilus includes Windows local transcription paths and Windows SDK dictation integration in-repo | BETTER |
| Speaker separation on Windows | Superwhisper documents this as in progress on Windows | Nautilus includes diarization pipeline, model management, and speaker-label merge path | BETTER |
| System audio capture on Windows | Superwhisper documents it as experimental on Windows | Nautilus exposes mixed mic plus system audio capture and setup diagnostics on both launch platforms | BETTER |
| Meeting assistant depth | Superwhisper markets meeting assistant and automatic notes | Nautilus adds meeting recording, transcript browsing, diarization hooks, local analysis, retention, backup, and recovery UX | BETTER |
| Bring your own API keys | Superwhisper markets own-API-key support | Nautilus settings already manage provider secrets for ASR and analysis providers | PARITY |
| File sync or cloud sync | Superwhisper markets FileSync | Nautilus has backup plus cloud sync plumbing, but packaged QA evidence is still blocked | PARTIAL |
| 100+ language breadth | Superwhisper publicly markets 100+ languages and dialects | Nautilus currently certifies a narrower frozen launch-language set with truthful evidence | BEHIND |
| Translate any spoken language to English | Superwhisper changelog publicly advertises this option | Nautilus does not ship an explicit equivalent launch feature or audit evidence today | BEHIND |
| User-facing file transcription | Superwhisper homepage markets file transcription | Nautilus has file-transcription-capable backend pieces, but no clear user-facing launch path in the app surface | BEHIND |
| Mouse shortcut control | Superwhisper documents mouse-button shortcut support on macOS | Nautilus currently exposes keyboard-first controls, not a mouse-button shortcut product path | BEHIND |

## Verdict

For the core dictation-first launch bar, Nautilus is at parity or better on the interactive workflow that matters most:

- hotkey capture
- push-to-talk
- live preview
- mini window workflow
- custom and context-aware modes
- history and reprocessing
- local-first and Windows flexibility

Nautilus is already stronger than Superwhisper in several product areas that matter for a dictation-first desktop app with meeting depth:

- Windows local transcription paths
- Windows restore-clipboard behavior
- Windows speaker-separation path
- Windows system-audio path
- meeting capture and transcript workflow depth

Nautilus is still behind Superwhisper on a few marketed surface-area items:

- public 100+ language breadth claim
- explicit translate-any-language-to-English mode
- clear user-facing file transcription workflow
- mouse-button shortcut controls

## Launch Recommendation

Use this comparison for launch messaging:

- Claim parity-or-better for core dictation workflow, local-first flexibility, and meeting depth.
- Do not claim parity on 100+ languages, translate-to-English, or file transcription until the product surface and packaged evidence exist.
- Treat mouse-button shortcuts as optional backlog work, not a launch blocker.
