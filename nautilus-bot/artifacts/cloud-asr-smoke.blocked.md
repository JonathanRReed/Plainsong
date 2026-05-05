# Cloud ASR Smoke Gate (Blocked)

## Command

- Preflight: `bun run gate:cloud-asr:preflight`
- Live smoke: `bun run qa:cloud-asr:smoke`
- Live output: `artifacts/cloud-asr-smoke.json`
- Live verifier: `scripts/verify-cloud-asr-smoke.mjs`

Status: BLOCKED
Generated: 2026-05-05T15:17:06.616Z

## Secret-Safe Preflight

- Fixture exists: yes
- Fixture SHA-256: cb9568ee93b04dba4a309580b45a0369e486682e2e57305ac8f302630bb8e2ea
- Missing env vars: OPENAI_API_KEY, ELEVENLABS_API_KEY, MISTRAL_API_KEY
- Secret policy: Only key names and boolean presence are recorded. Secret values are never written.

## Blocking Detail

- Missing required live cloud ASR secrets: OPENAI_API_KEY, ELEVENLABS_API_KEY, MISTRAL_API_KEY

## Required Follow-Up

- Provide `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and `MISTRAL_API_KEY` in the environment.
- Run `bun run qa:cloud-asr:smoke`.
- Run `bun run gate:blockers:refresh` after the live smoke passes.
