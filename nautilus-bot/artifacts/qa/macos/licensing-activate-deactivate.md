# Licensing: License activation/deactivation

Status: BLOCKED
Owner: qa-macos
Generated: 2026-05-03T15:54:57.229Z

## Evidence

- Artifact: `artifacts/qa/macos/licensing-activate-deactivate-live.json`
- Command: `bun run qa:packaged:macos:license-live`
- App: `release/mac-arm64/Nautilus.app`
- Sidecar: `release/mac-arm64/Nautilus.app/Contents/Resources/sidecar/nautilus-sidecar`

## Secret-Safe Preflight

- App exists: yes
- Sidecar exists: yes
- NAUTILUS_QA_LICENSE_KEY present: no
- Missing prerequisites: NAUTILUS_QA_LICENSE_KEY
- Secret policy: Only key names and boolean presence are recorded. License values are never written.

## Blocking Detail

- Set `NAUTILUS_QA_LICENSE_KEY` to a disposable Lemon Squeezy test key and rerun `bun run qa:packaged:macos:license-live`.
- The live harness refuses to overwrite an existing valid local license unless `--allow-existing-license` is passed.
- Run `bun run gate:blockers:refresh` after the live license capture passes.
