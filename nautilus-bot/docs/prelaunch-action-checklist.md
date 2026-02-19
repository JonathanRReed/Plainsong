# Pre-Launch Action Checklist

This checklist tracks the remaining pre-launch actions after code audit remediations for macOS + Windows.

## A) Release Secrets and Signing

- [ ] Confirm `TAURI_SIGNING_PRIVATE_KEY` is present in GitHub Actions secrets.
- [ ] Confirm `TAURI_SIGNING_PUBLIC_KEY` is present and matches private key pair.
- [ ] Confirm all macOS signing/notarization secrets are set (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `KEYCHAIN_PASSWORD`).
- [ ] Confirm Windows signing secrets are set (`WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`).

## B) Packaged App QA (Required)

- [ ] Execute full macOS packaged QA matrix and attach evidence.
- [ ] Execute full Windows packaged QA matrix and attach evidence.
- [ ] Validate updater check/install path on both platforms with signed artifacts.
- [ ] Validate fresh install and upgrade paths on both platforms.

## C) Release Ops

- [ ] Run release workflow from clean tag and verify all jobs green.
- [ ] Validate generated update manifests for stable channel.
- [ ] Verify deployed manifests are accessible and correct.
- [ ] Verify release artifacts are attached and signatures present.

## D) Final Signoff

- [ ] Engineering signoff.
- [ ] QA signoff.
- [ ] Product/owner go-live signoff.
- [ ] Mark Go/No-Go decision in `docs/prelaunch-readiness.md`.
