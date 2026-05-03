# Cloud ASR Smoke Gate

Status: BLOCKED
Generated: 2026-05-03T15:54:57.236Z

## Command

- Preflight: `bun run gate:cloud-asr:preflight`
- Live smoke: `bun run qa:cloud-asr:smoke`
- Live output: `artifacts/cloud-asr-smoke.json`
- Live verifier: `scripts/verify-cloud-asr-smoke.mjs`

## Secret-Safe Preflight

- Fixture exists: yes
- Fixture SHA-256: cb9568ee93b04dba4a309580b45a0369e486682e2e57305ac8f302630bb8e2ea
- Missing env vars: OPENAI_API_KEY, ELEVENLABS_API_KEY, MISTRAL_API_KEY
- Secret policy: Only key names and boolean presence are recorded. Secret values are never written.

## Required Follow-Up

- Provide `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and `MISTRAL_API_KEY` in the environment.
- Run `bun run qa:cloud-asr:smoke`.
- Run `bun run gate:blockers:refresh` after the live smoke passes.
