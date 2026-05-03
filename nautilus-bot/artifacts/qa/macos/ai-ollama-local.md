# AI: Local analysis (Ollama) flow

Status: PASS
Owner: qa-macos
Generated: 2026-05-02T20:57:56.954Z

## Command

`bun run qa:packaged:macos:ollama`

## Evidence

- Packaged sidecar launched from `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`.
- Ollama was available and the selected local model `gpt-oss:20b` was installed.
- Grounded summary returned transcript citations for signing, QA evidence, and Windows installer validation.
- Grounded action-item extraction returned owner/deadline items for Jon and Priya with transcript citations.
- Temporary QA database fixture was removed and the original database hash was restored.

## Artifact

`artifacts/qa/macos/ai-ollama-local.json`
