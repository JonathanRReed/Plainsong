# Competitive Readiness Matrix

Generated: 2026-05-03

This matrix maps NautilusBot readiness against current dictation and meeting-note alternatives. It is evidence-first: rows only count as ready when local artifacts prove the behavior.

## Sources Checked

- Wispr Flow: https://wisprflow.ai
- Whispur: https://whispur.app
- OpenWhispr: https://openwhispr.com and https://github.com/OpenWhispr/openwhispr
- dybur: https://dybur.com
- Granola transcription docs: https://docs.granola.ai/article/transcription
- Granola AI-enhanced notes docs: https://docs.granola.ai/help-center/taking-notes/ai-enhanced-notes
- Meetily open-source meeting assistant: https://meetily.ai/open-source
- Wren: https://getwren.dev

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

## Readiness Conclusion

NautilusBot has stronger local product scope than single-purpose dictation tools when macOS evidence is considered: it covers dictation, meeting capture, retention, backup, local AI analysis, and exports. It is not yet competitive-ready across the stated launch surface because Windows packaged QA, live cloud ASR, live license activation, and most app-matrix insertion evidence remain blocked.

The current objective is therefore still `NO-GO` until `docs/launch-completion-audit.md` reports `READY_EXCEPT_SIGNING_AND_PUBLISHING`.
