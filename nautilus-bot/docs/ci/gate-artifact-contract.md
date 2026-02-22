# Release Gate Artifact Contract

This document defines mandatory release evidence artifacts and their schema bindings.

## Required Artifacts

| Artifact name | Producer step | Schema |
| --- | --- | --- |
| `cloud-asr-smoke.json` | `scripts/live-cloud-asr-smoke.mjs` | `docs/ci/schemas/cloud-asr-smoke.schema.json` |
| `asr-preflight-macos.json` | `scripts/provision-asr-assets.mjs` | `docs/ci/schemas/asr-preflight.schema.json` |
| `asr-preflight-windows.json` | `scripts/provision-asr-assets.mjs` | `docs/ci/schemas/asr-preflight.schema.json` |
| `cold-start-macos.json` | `scripts/cold-start-gate.mjs` | `docs/ci/schemas/cold-start-gate.schema.json` |
| `packaged-qa-evidence-bundle-macos.json` | `scripts/export-qa-evidence-bundle.mjs` | `docs/ci/schemas/packaged-qa-evidence-bundle.schema.json` |
| `packaged-qa-evidence-bundle-windows.json` | `scripts/export-qa-evidence-bundle.mjs` | `docs/ci/schemas/packaged-qa-evidence-bundle.schema.json` |

## Enforcement

- `scripts/validate-gate-artifact.mjs` validates each artifact against its JSON schema.
- Release jobs fail when a required artifact is missing or schema-invalid.
