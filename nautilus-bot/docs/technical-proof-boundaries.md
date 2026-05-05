# Technical Proof Boundaries And Release Gates

Date: 2026-04-18
Owner: CTO
Source issue: HEL-30
Status: active

This document defines the technical proof boundary for NautilusBot launch decisions. It is the CTO-owned interpretation layer between implementation status, QA evidence, release evidence, and public claims.

## Decision

NautilusBot remains `NO-GO` for public GA until the strict release gates below have packaged, reproducible evidence for the frozen launch scope.

The current codebase can be described as implemented and locally validated for several core workflows, but it is not release-certified. Local fixture success, local dev signing, and blocker stubs do not satisfy the GA proof bar.

## Proof Vocabulary

Use these terms consistently in engineering, QA, product, and marketing handoffs:

| Term | Meaning | Public claim status |
| --- | --- | --- |
| `implemented` | Feature code exists and repo-side automated checks pass. | Allowed only as internal or prelaunch wording. |
| `locally validated` | Local fixtures, local benchmarks, or local unsigned/dev-signed builds pass. | Not enough for launch certification. |
| `packaged verified` | A packaged macOS or Windows build has executed evidence for the relevant workflow. | May support narrow certified claims. |
| `release certified` | Signed/notarized release artifact, packaged QA, required cloud smoke, and claim evidence all pass for the frozen scope. | Required for GA claims. |
| `public claimable` | Claim is present in `docs/launch-claim-scope.md` and backed by release-certified or explicitly scoped packaged evidence. | Allowed in public launch copy. |

## Boundary Rules

1. Implementation is not proof. A feature can be shipped in code and still remain out of launch claims.
2. Local evidence is not packaged evidence. Fixture-driven macOS and Windows benchmark JSON files prove regression coverage, not packaged app behavior.
3. Dev signing is not release signing. A locally signed macOS bundle is useful for engineering validation, but it does not prove Gatekeeper, notarization, update, or customer install readiness.
4. BYOK cloud support is not local-only behavior. Cloud-backed ASR, analysis, or backup flows must be described as optional provider-backed paths.
5. Matrix coverage is frozen before proof collection. Apps, languages, providers, and workflows may not be added to launch claims during the release evidence run.
6. Missing credentials are release blockers, not QA skips. Cloud ASR, Apple notarization, and Windows signing evidence remain blocked until credentials exist and gates are rerun.
7. Any failed or blocked launch-critical packaged row either blocks GA or removes the related claim from launch scope.

## Frozen Launch Scope

The proof run is limited to these repo-owned control surfaces:

| Scope Area | Source Of Truth | Proof Requirement |
| --- | --- | --- |
| Launch dashboard | `docs/launch-readiness-dashboard.md` | Dashboard reports `GO` only after all required gates pass. |
| Release gate evidence | `docs/release-gate-evidence.md` | Command-level evidence is current, reproducible, and matches artifacts. |
| Blockers | `docs/strict-release-blocker-register.md` | No active high-severity blocker remains for launch-critical scope. |
| Packaged QA | `docs/packaged-app-qa-matrix.md` | Required rows are executed as `PASS`, or failed rows have defect IDs and removed claims. |
| Claims | `docs/launch-claim-scope.md` | Public copy uses only verified, narrow wording. |
| App compatibility | `docs/dictation-app-compatibility-matrix.md` | App-specific claims require packaged insertion evidence. |
| Language certification | `docs/evals/dictation-language-certification-matrix.md` | Language claims require benchmark-backed certification for packaged scope. |
| Dictation parity | `docs/evals/dictation-parity-launch-scorecard.md` | CP-13, CP-14, and CP-15 evidence passes on packaged macOS and Windows artifacts. |

## Release Gates

These gates define the NautilusBot GA bar. `P0` gates are stop-ship. `P1` gates are required for credible competitor-parity claims.

| Gate | Priority | Required Evidence | Current State |
| --- | --- | --- | --- |
| `RG-01` Release credentials and signing | P0 | Apple release signing, Apple notarization, Windows signing certificate, and release update credentials are present in the release environment and validated without exposing secrets. | Blocked by missing external credentials. |
| `RG-02` Cloud ASR smoke | P0 | Live OpenAI, ElevenLabs, and Mistral smoke artifacts pass in strict mode with release-scoped credentials. | Blocked by missing cloud API secrets. |
| `RG-03` Packaged QA matrix | P0 | Required macOS and Windows packaged QA rows move from `BLOCKED` to executed `PASS`, or failures have defect IDs and removed claims. | Blocked: current matrix has blocker stubs, not executed pass evidence. |
| `RG-04` Packaged dictation parity | P0 | Packaged macOS and Windows CP-13 command, CP-14 snippet, and CP-15 latency/provider-integrity gates pass against the frozen corpus. | Partial: local fixture-driven gates pass; packaged evidence is absent. |
| `RG-05` Packaged meeting reliability | P1 | Meeting processing, transcript-only mode, retention/delete modes, consent indicator, export, backup, and 3-hour soak rows pass on packaged builds. | Blocked until packaged QA execution. |
| `RG-06` Install, update, and trust chain | P0 | Fresh install, upgrade, signed update, Gatekeeper/notarization, and Windows signing evidence pass on release artifacts. | Blocked by release signing prerequisites. |
| `RG-07` Data safety and paid-product integrity | P0 | Licensing, secure storage, backup restore, iCloud sync, and renderer command allowlist remain green in automated and packaged checks. | Implemented locally; must remain green during packaged release run. |
| `RG-08` Claim freeze | P0 | `docs/launch-claim-scope.md` includes only claims backed by release-certified or explicitly scoped packaged evidence. | Partially defined; final freeze must happen after packaged evidence exists. |

## Go Or No-Go Rule

NautilusBot may move from `NO-GO` to `GO` only when:

- every `P0` release gate is `PASS`,
- every launch-critical `P1` claim is either backed by packaged evidence or removed from public scope,
- `docs/launch-readiness-dashboard.md` and `artifacts/launch-readiness-report.json` agree,
- `docs/launch-claim-scope.md` is updated after evidence collection, not before it,
- engineering, QA, and product each sign off against the same evidence bundle.

Any of these conditions force `NO-GO`:

- unsigned, unnotarized, or unvalidated customer install path,
- blocked cloud ASR smoke while cloud providers remain in GA scope,
- packaged QA rows still blocked for launch-critical workflows,
- app or language claims exceeding packaged evidence,
- privacy, local-first, backup, or update claims broader than the artifacts prove.

## Release Credential Preflight

`bun run gate:release-credentials:preflight` is a secret-safe readiness check for `RG-01`. It writes `artifacts/release-credential-preflight.json` and `artifacts/release-credential-preflight.md`.

This preflight is not signing evidence. It only confirms whether the expected Apple, Windows, and GitHub release inputs appear to be present without recording secret values or certificate contents. `RG-01` remains blocked until signed macOS and Windows artifacts pass the validation commands in `docs/CODE_SIGNING.md`.

## Public Boundary As Of 2026-04-18

Allowed public/prelaunch posture:

- controlled waitlist or private beta language,
- local-first by default,
- optional BYOK cloud providers,
- implemented dictation and meeting workflows,
- narrow evidence-backed internal benchmark references.

Disallowed until gates pass:

- GA availability,
- works-everywhere dictation,
- certified app or language breadth without packaged evidence,
- signed update reliability,
- notarized macOS or signed Windows install readiness,
- packaged meeting reliability,
- fully local claims for provider-backed workflows.

## Next Engineering Actions

1. Assign a release owner for `RG-01`, because external credentials are the current critical path.
2. Execute `RG-02` only after release-scoped cloud credentials are available.
3. Convert `docs/packaged-app-qa-matrix.md` from blocker stubs into dated execution rows for signed macOS and Windows builds.
4. Capture packaged dictation parity artifacts and update the app/language matrices before any claim freeze.
5. Re-run the launch dashboard generation and perform the final claim freeze only after packaged evidence exists.
