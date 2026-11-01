# Candidate release receipts

Run qualification against the final signed, notarized candidate. Keep one QA directory per candidate. The pre-audit reads the filenames below. A narrative qualification report cannot replace them.

## Requirement map

The b26 column describes the retained-output conversion on October 30, 2026. It does not qualify b27.

| Requirement | Receipt or direct input | Producer | b26 |
| --- | --- | --- | --- |
| beta-identity | package.json, app Info.plist, versioned DMG/ZIP, beta-mac.yml | pre-audit | proved |
| release-artifacts | app, DMG, ZIP, blockmap, beta-mac.yml hashes | pre-audit | proved |
| developer-id-signing | macos-trust.json | verify-macos-release-trust.ts | proved |
| update-metadata | update-metadata.json | verify-packaged-macos-update-metadata.ts | proved |
| local-transcription | transcription-whisper-e2e.json | capture-packaged-macos-whisper-transcription.ts | missing; b26 used Parakeet |
| backup-restore | backup-create-restore.json | capture-packaged-macos-backup-restore.ts | missing; no backup/restore measurement |
| retention | retention-policies.json | capture-packaged-macos-retention.ts | missing; no complete policy run |
| exports | exports.json | capture-packaged-macos-exports.ts | missing; aside audio export is not the standard/template export suite |
| memory-footprint | footprint-8gb.json | capture-packaged-macos-footprint.ts | contradicted; retained run 3 fails open idle |
| memory-footprint-16gb | footprint-16gb.json | capture-packaged-macos-footprint.ts | contradicted; retained Full run fails open idle |
| host-matrix | app-matrix-preflight.json | packaged insertion captures and app-matrix preflight | missing; Capture Pad does not prove all required host apps |
| meeting-microphone | capture-meeting-mic.json | packaged mic script, or retained footprint/capture conversion | proved; completed BlackHole microphone capture, virtual fixture only |
| meeting-system-audio | capture-system-audio-test.json | capture-packaged-macos-system-audio-test.ts | missing; active system audio is not a known-tone measurement |
| meeting-lifecycle | meeting-lifecycle.json | capture-packaged-macos-meeting-lifecycle.ts | missing; no complete 15-scenario receipt |
| meeting-soak | capture-soak-3h.json | capture-packaged-macos-meeting-soak.ts | missing; b26 capture was about two minutes |
| source-gates | source-gates.json | capture-source-gates.ts | missing; retained log list lacks the complete gate set and source snapshot |
| rendered-first-run | rendered-ux.json | record-release-review.ts with a recorded walkthrough | missing; recap/HUD screenshots do not cover first-run/daily UX |
| release-code-review | code-review.json | record-release-review.ts with ordinary source review | missing; no source-matched review receipt |
| apple-distribution | macos-trust.json | verify-macos-release-trust.ts | proved |
| clean-install | clean-install.json | record-release-review.ts with quarantined install/permission observations | missing; launching a QA bundle copy is not a clean install |
| signed-updater | release-scope-exceptions.json | Jonathan's recorded beta.7 decision | excluded by decision |
| support-bundle | support-bundle.json | capture-support-bundle.ts | missing; no preview/redaction capture |
| packaged-licenses | packaged licenses and current dependency graph | pre-audit | proved |
| package-size | full app bundle bytes | pre-audit | proved |

The 24 rows total 8 proved, 2 contradicted, 13 missing and 1 excluded by decision. The audit remains BLOCKED.

The audible benchmark is outside these 24 requirements. For `0.9.0-beta.7`, `release-scope-exceptions.json` records five decisions by Jonathan. The audit lists each decision and its reason in JSON and Markdown.

| Date | Requirement | Excluded scope | Decision | Reason |
| --- | --- | --- | --- | --- |
| 2026-10-30 | signed-updater | Whole requirement | beta.5→beta.7 updater journey: skipped by Jonathan 2026-10-30 | if it breaks they can reload it |
| 2026-10-30 | audible-benchmark | Whole benchmark, outside the audit rows | audible benchmark: skipped for beta.7 by Jonathan 2026-10-30 | b23 measurement stands |
| 2026-10-31 | memory-footprint | 8 GB tier, `idle-after-dictation` only | Accept 8 GB window-open idle after dictation for beta.7; fix in beta.8 | Average is at the 300 MiB limit with the speech model kept warm and the main window open; brief graphics peaks to 534 MiB; window closed is about 200 MiB. |
| 2026-10-31 | host-matrix | `Google Docs (Chrome)` only | Skip Google Docs typing for beta.7 | Chrome has no QA connection on this Mac; Notes, Slack and Messages pass. |
| 2026-10-31 | clean-install | Clean-account permission and first dictation/insertion journey only | Skip fresh-account install journey for beta.7 | Needs a new macOS user account; quarantined DMG install, signatures and Gatekeeper pass. |

Whole exclusions report `excluded by decision`. Partial exclusions report `proved with scoped exclusion` only when every remaining check passes. The summary counts these separately from `proved`. A failed requirement retains its scoped decision and stays blocked. Post-audit acceptance checks the exact decision, scope, candidate version and status. Unknown requirements, extra fields and broader scopes are rejected.

The 8 GB exclusion covers the named state's app-tree and effective-memory budget verdicts. Every other state, simulation, standard workload, measurement errors and candidate binding must pass. The 16 GB gate has no exclusion. The host matrix still requires Apple Notes, Slack, Messages and any other required host. Clean install still requires the quarantined DMG/Gatekeeper and disposable-install observations, including their signature and bundle-match evidence, plus the exact release binding. Its receipt groups the skipped journey under `first-run-permission-flow` and `local-dictation-and-meeting`; the separate meeting requirements still apply. Only b27's exact free-text finding about that journey is accepted; other launch findings block.

Physical 8 GB hardware is unavailable. Simulated Light-tier footprint receipts do not qualify physical 8 GB behavior. Encrypted migration has source-test evidence only. The packaged encrypted journey remains unqualified. Neither has an exception.

## b27 QA checklist

These commands are for the candidate qualification operator. This tooling change does not execute them. Run from `nautilus-bot/`. Use absolute paths outside the production app/profile and a disposable seeded QA profile containing the required local models and fixtures. Preserve raw outputs, screenshots and logs. Do not modify the signed candidate between capture and audit.

```sh
CANDIDATE=/absolute/path/to/candidate-b27
APP="$CANDIDATE/mac-arm64/Plainsong.app"
QA=/absolute/path/to/b27-qa
SEED=/absolute/path/to/disposable-qa-seed
PROFILE=/absolute/path/to/b27-disposable-profile
cp -cR "$SEED" "$PROFILE"
mkdir -p "$QA"
```

- [ ] Verify final artifacts, trust and metadata. These cover four direct/receipt requirements plus signing and Apple distribution. The pre-audit also verifies packaged licenses and the 450 MiB app limit.

```sh
bun scripts/verify-macos-release-trust.ts --app "$APP" --release-dir "$CANDIDATE" --out "$QA/macos-trust.json" --markdown "$QA/macos-trust.md"
bun scripts/verify-packaged-macos-update-metadata.ts --app "$APP" --manifest "$CANDIDATE/beta-mac.yml" --out "$QA/update-metadata.json" --markdown "$QA/update-metadata.md"
```

- [ ] Capture the local model and data-management gates. The supplied profile must already contain `config/Plainsong/settings.json`, `data/Plainsong/models/` and a disposable `data/Plainsong/plainsong.db`. These are QA fixtures, never copies of production personal data. Each command receives the prepared profile through `--profile-root`. Every output must report `pass: true`, the full app digest and `candidateAppUnchanged: true`.

```sh
bun scripts/capture-packaged-macos-whisper-transcription.ts --app "$APP" --profile-root "$PROFILE" --out "$QA/transcription-whisper-e2e.json"
bun scripts/capture-packaged-macos-backup-restore.ts --app "$APP" --profile-root "$PROFILE" --out "$QA/backup-create-restore.json"
bun scripts/capture-packaged-macos-retention.ts --app "$APP" --profile-root "$PROFILE" --out "$QA/retention-policies.json"
bun scripts/capture-packaged-macos-exports.ts --app "$APP" --profile-root "$PROFILE" --out "$QA/exports.json"
```

- [ ] Measure both complete standard footprint workloads after `dadf2a93`. Do not select an idle-only run, skip states, add a stress memory cap, or replace failed observations with historical peaks.

```sh
bun scripts/capture-packaged-macos-footprint.ts --app "$APP" --profile-root "$PROFILE" --candidate "$CANDIDATE" --simulate-gb 8 --out "$QA/footprint-8gb.json"
bun scripts/capture-packaged-macos-footprint.ts --app "$APP" --profile-root "$PROFILE" --candidate "$CANDIDATE" --simulate-gb 16 --out "$QA/footprint-16gb.json"
```

- [ ] Capture microphone, known-tone system audio, combined capture and the complete three-hour Parakeet soak. Use an admitted host and the prepared BlackHole fixture route. The soak's transcript match must pass; a shorter duration cannot qualify it. The separate audible dictation benchmark exclusion does not exclude the capture/soak tests.

```sh
bun scripts/capture-packaged-macos-meeting-mic.ts --app "$APP" --profile-root "$PROFILE" --out "$QA/capture-meeting-mic.json"
bun scripts/capture-packaged-macos-system-audio-test.ts --app "$APP" --profile-root "$PROFILE" --out "$QA/capture-system-audio-test.json"
bun scripts/capture-packaged-macos-meeting-mic.ts --app "$APP" --profile-root "$PROFILE" --system-audio --out "$QA/capture-meeting-system-audio.json"
bun scripts/capture-packaged-macos-meeting-soak.ts --app "$APP" --profile-root "$PROFILE" --candidate "$CANDIDATE" --record-ms 10800000 --min-record-ms 10800000 --provider parakeet --model parakeet-tdt-0.6b-v3 --speak-fixture --virtual-fixture-device "BlackHole 2ch" --out "$QA/capture-soak-3h.json" --markdown "$QA/capture-soak-3h.md"
```

- [ ] Record the nine real-device lifecycle scenarios, then aggregate all 15 scenarios. Begin the observation file before running them. Follow the review recording procedure below. Fill `evidence.processingQuitRecovery` with actual before/after states, saved audio size and final transcript size. The aggregator validates those fields.

```sh
bun scripts/qa/record-release-review.ts --kind meeting-lifecycle-real-device --begin --candidate "$CANDIDATE" --qa-dir "$QA"
# Exercise and record all nine scenarios in meeting-lifecycle-real-device.observations.json.
bun scripts/qa/record-release-review.ts --kind meeting-lifecycle-real-device --finish --candidate "$CANDIDATE" --qa-dir "$QA"
bun scripts/capture-packaged-macos-meeting-lifecycle.ts --app "$APP" --candidate "$CANDIDATE" --qa-dir "$QA"
```

- [ ] Capture verifier-clean insertion in every REQUIRED macOS host row: Apple Notes, Google Docs in Chrome, Slack and Messages. Each command must name a disposable, unsent scratch target and its real machine readback strategy. The insertion capture prints supported `--verify-mode` choices if one is omitted. Do not use `--observed` as proof. Update the evidence links in a QA copy of `docs/dictation-app-compatibility-matrix.md` to the fresh JSON/Markdown pairs. Then run the preflight. Historical b23 audible measurements cannot substitute for these host captures.

```sh
cp docs/dictation-app-compatibility-matrix.md "$QA/app-matrix.md"
bun scripts/run-packaged-macos-app-matrix-insertion.ts --app "$APP" --profile-root "$PROFILE" --target-app "$TARGET_APP" --verify-mode "$VERIFY_MODE" --scratch-target "$SCRATCH_TARGET" --out "$QA/app-matrix-insertion-$SLUG.json" --markdown "$QA/app-matrix-insertion-$SLUG.md"
bun scripts/capture-packaged-macos-app-matrix-preflight.ts --candidate-app "$APP" --matrix "$QA/app-matrix.md" --out "$QA/app-matrix-preflight.json" --markdown "$QA/app-matrix-preflight.md"
```

- [ ] Capture the support bundle from disposable QA inputs. Supply settings, diagnostics and an inventory, then inspect the resulting preview/redaction receipt. Avoid production paths.

```sh
bun scripts/capture-support-bundle.ts --app "$APP" --settings "$QA_SETTINGS" --diagnostics "$QA_DIAGNOSTICS" --inventory-root "$QA_INVENTORY" --out "$QA/support-bundle.json"
```

- [ ] Run all source gates on the final candidate source and save `source-gates.json`. Its command set includes Rust/native work. On a shared host, use the existing build-slot guard with `nice -n 10`, four Cargo jobs and an isolated target directory. Source gate capture must run in the candidate source checkout. A build or dependency gate cannot be inferred from this implementation task's three app checks.

```sh
bun scripts/capture-source-gates.ts --app "$APP" --out "$QA/source-gates.json"
```

- [ ] Record rendered first-run/daily UX, clean installation and ordinary code review. For clean installation, use a quarantined copy in a disposable install location and a clean test account/session for permission prompts. Do not replace `/Applications/Plainsong.app` or use the live profile. Source checks and onboarding automation alone cannot prove consent or clean installation.

```sh
bun scripts/qa/record-release-review.ts --kind rendered-first-run --begin --candidate "$CANDIDATE" --qa-dir "$QA"
bun scripts/qa/record-release-review.ts --kind clean-install --begin --candidate "$CANDIDATE" --qa-dir "$QA"
bun scripts/qa/record-release-review.ts --kind release-code-review --begin --candidate "$CANDIDATE" --qa-dir "$QA"
# Perform the walkthroughs and review, then complete each observations file.
bun scripts/qa/record-release-review.ts --kind rendered-first-run --finish --candidate "$CANDIDATE" --qa-dir "$QA"
bun scripts/qa/record-release-review.ts --kind clean-install --finish --candidate "$CANDIDATE" --qa-dir "$QA"
bun scripts/qa/record-release-review.ts --kind release-code-review --finish --candidate "$CANDIDATE" --qa-dir "$QA"
```

- [ ] Run pre after every required receipt exists. Inspect the requirement rows and the separate decision list. A failed/missing gate still blocks. No updater receipt or audible benchmark rerun is required under Jonathan's two recorded beta.7 decisions.

```sh
bun run qa:packaged:macos:release-audit:pre -- --candidate "$CANDIDATE" --qa-dir "$QA"
```

## Review recording procedure

`--begin` captures the complete release identity and writes `<kind>.observations.json` with every required observation set to `unrun`. Code review also captures the source snapshot and tracked diff from the passing `source-gates.json`.

Perform the named checks. In the observations file, enter `reviewer`, an ISO `observedAt` timestamp, and each observation's `status` as `pass` or `fail`. Add concrete `detail` and paths in `evidence` to nonempty screenshots, logs or review notes. Paths can be absolute or relative to the QA directory. Record unresolved issues in `remainingLaunchFindings`. Preserve the observation file.

`--finish` refuses unrun, missing or duplicate checks, absent evidence, stale release bytes or changed source-gate identity. It hashes evidence files and writes the exact audit filename. Failed observations or unresolved findings write `pass: false` and exit 1. The recorder formats observations; it does not perform the review or prove a claim by itself.

## Convert retained candidate QA outputs

Use `write-candidate-receipts.ts` after raw QA collection if the candidate's extended footprint tooling wrote different filenames. It never launches an app or remeasures anything. Use a fresh output directory. Existing app digests and unchanged markers must match the supplied candidate. Source file hashes and paths accompany each conversion.

```sh
bun scripts/qa/write-candidate-receipts.ts --candidate "$CANDIDATE" --qa-dir "$QA" \
  --footprint-8gb "$RAW/qa/footprint-8gb-3.json" \
  --footprint-16gb "$RAW/qa/footprint-16gb-1.json" \
  --microphone-footprint "$RAW/qa/footprint-16gb-1.json" \
  --microphone-capture "$RAW/qa/footprint-16gb-1.capture.json"
```

Footprint receipts retain their original pass/fail values and all state data. The microphone conversion checks named input resolution without fallback, recording identity, live transcription, completed transcript with at least 80% fixture coverage, an exercised sampled meeting and no capture error. It explicitly reports virtual input scope. It does not create known-tone, lifecycle, Whisper, export, soak or first-run proof. For b27's full lifecycle gate, use the dedicated mic-only capture script above so duplicate Stop and processing evidence are present.
