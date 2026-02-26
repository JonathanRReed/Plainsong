# Pre-Launch Action Checklist

This checklist tracks remaining release blockers for strict all-provider GA on macOS + Windows.

## A) Required Secrets

- [ ] Confirm updater/signing secrets are set: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PUBLIC_KEY`.
- [ ] Confirm macOS signing/notarization secrets are set (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `KEYCHAIN_PASSWORD`).
- [ ] Confirm Windows signing secrets are set (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`).
- [ ] Confirm cloud ASR live-test secrets are set (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY`).
- [ ] Optional but recommended for deterministic preflight provisioning: set `NAUTILUS_ASR_ASSET_BUNDLE_URL` to a tar/zip bundle that expands into `Nautilus/models/*`.

## B) Provider Runtime Prerequisites

- [ ] Ensure local model assets are available for local-provider CI/perf gates (Whisper, Parakeet, Canary, Distil-Whisper, Moonshine, Voxtral-local).
- [ ] Ensure Python runtime dependencies are available where local Python-bridge providers are exercised (`torch`, `transformers`, `librosa`, `soundfile`, `huggingface_hub`).

## C) Automated Gates

- [ ] Release workflow `prepare` job passes secret validation + cloud smoke gate.
- [ ] Rust live cloud integration test gate passes (`asr_live_cloud_integration`).
- [ ] Local ASR performance gate passes (`asr_local_performance_gate`, RTF <= 1.2).
- [ ] Local ASR performance gate runs with fail-fast provider policy (no hidden fallback passes).
- [ ] Cold-start gate passes on M1-class baseline (`scripts/cold-start-gate.mjs`, threshold < 2500ms).
- [ ] Bundle size gate passes (`node scripts/size-gate.mjs --app src-tauri/target/release/bundle/macos/Nautilus.app --max-mb 35`).
- [ ] Standard build-quality gates remain green (`tsc`, `npm test`, `vite build`, `fmt`, `clippy`, `check`, `test --lib`).

## D) Packaged QA (Required)

- [ ] Execute full macOS packaged QA matrix and attach evidence.
- [ ] Execute full Windows packaged QA matrix and attach evidence.
- [ ] Validate updater check/install path on both platforms with signed artifacts.
- [ ] Validate fresh install and upgrade paths on both platforms.
- [ ] 3h mic+system meeting soak test passes (record → stop → transcript complete).
- [ ] Idle CPU baseline in packaged app is < 1% while app window is open and not recording.

## E) Competitor Parity Gates (Required)

- [ ] Complete all `CP-*` launch blockers in `docs/competitor-parity-gates.md` with `PASS` status only.
- [ ] Confirm meeting processing UX parity (`processing` state, spinner, auto-refresh transcript in detail view).
- [ ] Confirm transcript-only and retention-delete modes behave exactly as configured.
- [ ] Confirm onboarding parity for Normal + Power tracks, including persistence behavior.
- [ ] Confirm licensing parity (tier unlock matrix + 30-day lockout behavior).
- [ ] Confirm at least one cloud backup provider passes setup + sync + restore.
- [ ] Validate benchmark artifact schema (`docs/evals/benchmark-run.schema.json`) and provider-integrity fields in CP-15 evidence.
- [ ] Validate meeting status event markers (`meetingProcessingStartedAt`, `transcriptFirstAvailableAt`, `consentPromptShown`) in packaged QA logs.

## F) Final Signoff

- [ ] Engineering signoff.
- [ ] QA signoff.
- [ ] Product/owner go-live signoff.
- [ ] Record final Go/No-Go in `docs/prelaunch-readiness.md`.
