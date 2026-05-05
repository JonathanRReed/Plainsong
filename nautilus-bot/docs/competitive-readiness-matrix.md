# Competitive Readiness Matrix

Generated: 2026-05-05

This matrix maps NautilusBot readiness against current dictation and meeting-note alternatives. It is evidence-first: rows only count as ready when local artifacts prove the behavior.

Deep research artifacts:

- `docs/research/competitive-research-2026-05-05.md`
- `docs/research/competitive-matrix-2026-05-05.csv`

## Sources Checked

- Wispr Flow: https://wisprflow.ai
- Whispur: https://whispur.app
- OpenWhispr: https://openwhispr.com and https://github.com/OpenWhispr/openwhispr
- dybur: https://dybur.com
- Granola transcription docs: https://docs.granola.ai/article/transcription
- Granola AI-enhanced notes docs: https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes
- Meetily open-source meeting assistant: https://meetily.ai/open-source
- Wren: https://getwren.dev
- Deep research source register: `docs/research/competitive-matrix-2026-05-05.csv`

## Competitive Bars

| Capability | Competitive bar | NautilusBot evidence | Status |
| --- | --- | --- | --- |
| System-wide dictation | Text lands in real apps, not only an internal editor. | `artifacts/dictation-app-matrix-gate.json`; only Apple Notes is launch-ready today. | BLOCKED |
| Local-first ASR | Local Whisper or Parakeet-class transcription is available. | `artifacts/dictation-parity-evidence.json`, `docs/evals/dictation-language-certification-matrix.md`, `artifacts/benchmark-gates-macos.json`, `artifacts/benchmark-gates-windows.json`. | PASS |
| Cloud ASR choice | Optional cloud ASR providers can be live-smoked without storing secrets in artifacts. | `artifacts/cloud-asr-preflight.json`, `artifacts/cloud-asr-smoke.blocked.md`. | BLOCKED |
| AI cleanup and formatting | Dictation can run post-processing for punctuation, formatting, corrections, and commands. | `artifacts/dictation-prompt-eval.json`. | PASS |
| Cross-platform packaged behavior | macOS and Windows packaged builds both have product QA evidence. | `artifacts/packaged-qa-evidence-bundle.json`, `docs/windows-packaged-qa-handoff.md`, `scripts/windows-packaged-qa-runner.ps1`. | BLOCKED |
| Meeting transcription | Live meeting capture and processing are validated. | macOS evidence exists in `artifacts/qa/macos`; Windows meeting rows remain blocked in `artifacts/packaged-qa-evidence-bundle.json`. | BLOCKED |
| AI meeting notes | Meeting transcripts can be summarized and exported with action-oriented outputs. | `artifacts/qa/macos/ai-ollama-local.md`, `artifacts/qa/macos/exports.md`; Windows AI and export rows remain blocked. | BLOCKED |
| Privacy and retention | Users can control audio and transcript retention. | `artifacts/qa/macos/retention-transcript-only.md`, `artifacts/qa/macos/retention-audio-only.md`, `artifacts/qa/macos/retention-audio-and-transcript.md`; Windows retention rows remain blocked. | BLOCKED |
| Backup and restore | Local backup and restore paths are tested. | `artifacts/qa/macos/backup-create-restore.md`; Windows backup rows remain blocked. | BLOCKED |
| Launch claim discipline | Public copy does not claim unsupported app or language coverage. | `artifacts/launch-claim-check.json`, `docs/launch-claim-scope.md`. | PASS |
| Provider fallback transparency | Dictation must report requested provider, actual provider, requested model, actual model, route preference, resolved route, target app, and insertion mode so fallback is visible rather than hidden. | `rust-sidecar/src/models.rs`, `rust-sidecar/src/lib.rs`, `src/components/popups/dictation-popup.tsx`. | PASS |
| Overlay lifecycle control | Dictation overlay close and stale state handling must not fight between frontend, Electron, and backend ownership. | `src/components/popups/dictation-popup.tsx`, `src/__tests__/dictation-popup.test.tsx`. | PASS |
| Settings first-load guard | Settings must render core controls from `getSettings()` while slower provider, permission, backup, storage, license, and model checks load independently. | `src/components/views/settings-view-simple.tsx`, `src/__tests__/settings-view-simple.test.tsx`. | PASS |
| Sidecar trust boundary | The sidecar must receive only documented runtime variables and provider keys, not the whole Electron process environment. | `electron/sidecar-env.ts`, `src/__tests__/electron-ipc-bridge.test.ts`. | PASS |
| IPC drift and timeout guard | Renderer commands must be checked against sidecar dispatch, and command timeouts must reflect fast reads versus long-running model, backup, analysis, and export work. | `scripts/verify-ipc-contract.mjs`, `electron/ipc-command-policy.ts`, `src/__tests__/electron-ipc-bridge.test.ts`. | PASS |

## Readiness Conclusion

NautilusBot has stronger local product scope than single-purpose dictation tools when macOS evidence is considered: it covers dictation, meeting capture, retention, backup, local AI analysis, and exports. The 2026-05-05 research pass reinforces that local-first is now table stakes among open-source competitors, so NautilusBot's defensible position depends on dual-surface workflow depth, fallback honesty, local trust boundaries, and evidence discipline, not broad privacy claims alone. It is not yet competitive-ready across the stated launch surface because Windows packaged QA, live cloud ASR, live license activation, signing, packaged meeting evidence, and most app-matrix insertion evidence remain blocked.

The current objective is therefore still `NO-GO` until `docs/launch-completion-audit.md` reports `READY_EXCEPT_SIGNING_AND_PUBLISHING`.
