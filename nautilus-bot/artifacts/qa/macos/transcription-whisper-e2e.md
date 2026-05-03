# Transcription: Whisper transcription end-to-end

Status: PASS
Owner: qa-macos
Evidence: artifacts/qa/macos/transcription-whisper-e2e.json

## Command

`bun run qa:packaged:macos:whisper`

## Verification

- Launched the packaged sidecar from `release/mac-arm64/Nautilus.app`.
- Verified Whisper runtime diagnostics reported `ready`.
- Ran packaged `benchmark_asr_providers` against `scripts/fixtures/local-quality-gate.wav`.
- Filtered the result to provider `whisper`.
- Verified model `base.en`, runtime `ready`, `nonEmptyTranscript: true`, and a valid transcript.

## Result

Whisper transcribed the fixture as:

`This is a Nautilus local quality gate sample, with enough spoken words for verification.`
