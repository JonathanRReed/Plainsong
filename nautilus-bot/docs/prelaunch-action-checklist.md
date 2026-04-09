# Pre-Launch Action Checklist

This checklist tracks remaining release blockers for strict all-provider GA on macOS + Windows.

Current blocker register: `docs/strict-release-blocker-register.md`.

## A) Required Secrets

- [ ] Confirm Electron release publishing and signing credentials are set in CI for the active release workflow.
- [ ] Confirm macOS signing and notarization credentials are set for the Electron packaging flow — BLOCKED (Apple setup unavailable in this cycle).
- [ ] Confirm Windows signing secrets are set (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`) — BLOCKED (Windows cert unavailable in this cycle).
- [ ] Confirm cloud ASR live-test secrets are set (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`) — BLOCKED (`scripts/live-cloud-asr-smoke.mjs` fails without these).
- [ ] Optional but recommended for deterministic preflight provisioning: set `NAUTILUS_ASR_ASSET_BUNDLE_URL` to a tar/zip bundle that expands into `Nautilus/models/*`.

## B) Provider Runtime Prerequisites

- [x] Ensure local model assets are available for local-provider CI/perf gates (Whisper, Parakeet, Canary, Distil-Whisper, Moonshine, Voxtral-local). (`artifacts/asr-preflight-macos.json`)
- [x] Ensure Python runtime dependencies are available where local Python-bridge providers are exercised (`torch`, `transformers`, `librosa`, `soundfile`, `huggingface_hub`). (`artifacts/asr-preflight-macos.json`)

## C) Automated Gates

- [ ] Release workflow `prepare` job passes secret validation + cloud smoke gate. — BLOCKED (missing cloud secrets).
- [x] Rust live cloud integration test gate passes (`asr_live_cloud_integration`).
- [x] Local ASR performance gate passes (`asr_local_performance_gate`, RTF <= 1.2).
- [x] Local ASR performance gate runs with fail-fast provider policy (no hidden fallback passes).
- [x] Cold-start gate passes on M1-class baseline (`scripts/cold-start-gate.mjs`, threshold < 2500ms). (historical evidence in `docs/release-gate-evidence.md`)
- [x] Bundle size gate passes (`node scripts/size-gate.mjs --app release/mac-arm64/Nautilus.app --max-mb 450`).
- [x] Current-platform local release sweep passes (`bun run gate:release:local`, artifact `artifacts/local-release-macos.json`).
- [ ] Benchmark launch gates pass via `scripts/verify-benchmark-gates.mjs` for both `benchmark-run-latest-macos.json` and `benchmark-run-latest-windows.json` against baseline. — BLOCKED (local fixture gates now pass, but packaged benchmark evidence is still missing).
- [x] Standard build-quality gates remain green (`bun run lint`, `bun run test`, `bun run build:renderer`, `fmt`, `clippy`, `check`, `test --lib`).

## D) Packaged QA (Required)

- [ ] Execute full macOS packaged QA matrix and attach evidence. — BLOCKED (rows currently BLOCKED pending credentials/execution).
- [ ] Execute full Windows packaged QA matrix and attach evidence. — BLOCKED (rows currently BLOCKED pending cert/execution).
- [ ] Validate updater check/install path on both platforms with signed artifacts. — BLOCKED (signing prerequisites unavailable).
- [ ] Validate fresh install and upgrade paths on both platforms. — BLOCKED (requires signed packaged artifacts for strict flow).
- [ ] 3h mic+system meeting soak test passes (record → stop → transcript complete). — BLOCKED (not executed in this cycle).
- [ ] Idle CPU baseline in packaged app is < 1% while app window is open and not recording. — BLOCKED (not executed in this cycle).

## E) Competitor Parity Gates (Required)

- [ ] Complete all `CP-*` launch blockers in `docs/competitor-parity-gates.md` with `PASS` status only.
- [ ] Complete all `DP-*` launch blockers in `docs/evals/dictation-parity-launch-scorecard.md` with `PASS` status only.
- [ ] Confirm meeting processing UX parity (`processing` state, spinner, auto-refresh transcript in detail view).
- [ ] Confirm transcript-only and retention-delete modes behave exactly as configured.
- [ ] Confirm onboarding parity for Normal + Power tracks, including persistence behavior.
- [ ] Confirm licensing parity (tier unlock matrix + 30-day lockout behavior).
- [ ] Confirm at least one cloud backup provider passes setup + sync + restore.
- [ ] Validate benchmark artifact schema (`docs/evals/benchmark-run.schema.json`) and provider-integrity fields in CP-15 evidence.
- [ ] Validate meeting status event markers (`meetingProcessingStartedAt`, `transcriptFirstAvailableAt`, `consentPromptShown`) in packaged QA logs.
- [ ] Freeze and maintain the launch app matrix in `docs/dictation-app-compatibility-matrix.md`.
- [ ] Track launch-problematic apps in `docs/dictation-blocked-app-register.md` until closed.

## F) Final Signoff

- [ ] Engineering signoff.
- [ ] QA signoff.
- [ ] Product/owner go-live signoff.
- [ ] Record final Go/No-Go in `docs/prelaunch-readiness.md`.
