# Launch Execution Plan

Date: 2026-04-09
Status: `NO-GO`
Audience: engineering, QA, product

## Goal

Turn the current audit into a launch sequence that gets NautilusBot to a truthful, defensible GA bar against:

- fast dictation competitors such as Wispr Flow, FreeFlow, and Superwhisper
- meeting workflow competitors such as Granola and OpenOats

The launch bar is not "the code exists." The launch bar is:

- packaged builds work reliably on macOS and Windows
- insertion works in the launch app matrix
- meeting capture and processing are trustworthy
- paid licensing is not trivially bypassed
- backup and restore do not risk customer data
- release evidence matches reality

## Priority Model

- `P0`: stop-ship, must close before launch
- `P1`: launch-critical, required for credible parity claims
- `P2`: hardening, should close before or immediately after launch candidate

## Workstreams

| ID | Priority | Workstream | Why it matters | Suggested owner | Effort | Dependencies | Exit criteria |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LX-01 | P0 | Make release evidence truthful | Current docs overstate readiness and security posture. | Engineering | S | None | `docs/release-gate-evidence.md`, `docs/prelaunch-readiness.md`, and blocker docs match current command output and known risks. |
| LX-02 | P0 | Clear dependency audit findings | A failing audit weakens launch trust and security review. | Engineering | S to M | LX-01 | `bun audit` passes, or remaining advisories are documented as accepted residual risk with version pinning and rationale. |
| LX-03 | P0 | Provision release secrets and signing | Signed updates, notarization, and live cloud smoke are blocked until credentials exist. | Founder or release owner | M | None | Apple signing, notarization, Windows signing, and cloud ASR secrets are present in the release environment and validated. |
| LX-04 | P0 | Execute packaged QA matrix | Launch proof is missing. Current matrix is `49 BLOCKED / 0 PASS`. | QA | L | LX-03 | Required matrix rows move from `BLOCKED` to executed `PASS` or documented `FAIL` with defect IDs. |
| LX-05 | P0 | Capture packaged dictation parity evidence | Nautilus cannot compete on dictation claims without packaged benchmark and app-matrix proof. | Engineering + QA | L | LX-03, LX-04 | `DP-*` scorecard is all `PASS`, packaged benchmark artifacts exist for macOS and Windows, and blocked launch apps are closed or removed from claims. |
| LX-06 | P0 | Harden licensing and trial enforcement | Trial state and license identity are locally editable, and the renderer receives license material. | Engineering | M to L | None | Trial state becomes tamper-resistant enough for launch, sensitive license fields stop flowing to the renderer, and expiry or entitlement tests pass across restart. |
| LX-07 | P0 | Make backup, restore, and iCloud sync atomic | Current flows can destroy or partially overwrite customer data on interruption. | Engineering | M | None | Restore uses staging plus rollback, sync avoids destructive delete-before-copy, and recovery behavior is tested. |
| LX-08 | P1 | Prove meeting reliability and recovery | Meeting apps win on trust, not just feature count. | QA + Engineering | M to L | LX-03, LX-04 | 3-hour soak, transcript-only mode, retention deletes, consent flow, and cloud backup path all have packaged PASS evidence. |
| LX-09 | P1 | Narrow high-impact renderer command surface | A generic invoke bridge increases blast radius if the renderer is ever compromised. | Engineering | M | None | Renderer can access only the required sidecar commands, with explicit allowlisting and regression coverage. |
| LX-10 | P1 | Freeze launch claims to verified scope | Marketing claims must match what is actually certified. | Product | S | LX-04, LX-05, LX-08 | Public launch claims list only verified apps, verified languages, and validated feature tiers. |

## Progress Update

Update date: 2026-04-09

- `LX-01`: complete
- `LX-02`: complete via dependency cleanup plus documented residual acceptance for the remaining Bun-reported Vite dev-server advisory path
- `LX-06`: complete
- `LX-07`: complete
- `LX-09`: complete

Still open:

- `LX-03`: external credentials and signing
- `LX-04`: packaged QA execution
- `LX-05`: packaged dictation parity evidence
- `LX-08`: packaged meeting reliability evidence
- `LX-10`: launch claim freeze after packaged evidence exists

## First 72 Hours

1. Decide who owns LX-03. This is the main external blocker.
2. Freeze the launch app matrix and launch language set so LX-05 can run without moving targets.
3. Convert the packaged QA matrix from blocker stubs into an execution schedule with dates, devices, and owners.
4. Execute packaged dictation and meeting runs on signed builds.
5. Freeze public claims only after the packaged evidence bundle is complete.

## Recommended Sequence

### Phase 1, unblock release execution

- LX-01 Truthful docs
- LX-02 Dependency audit cleanup
- LX-03 Signing and secret provisioning

### Phase 2, fix stop-ship product risks

- LX-06 Licensing hardening
- LX-07 Atomic backup and restore
- LX-09 Renderer command allowlist

### Phase 3, collect launch proof

- LX-04 Packaged QA matrix execution
- LX-05 Packaged dictation parity evidence
- LX-08 Meeting reliability evidence

### Phase 4, lock scope and ship

- LX-10 Freeze public claims to verified scope
- Final Go or No-Go review in `docs/prelaunch-readiness.md`

## Ticket Breakdown

### LX-06 Licensing hardening

- Stop returning plaintext license key material to the renderer.
- Split local entitlement cache from sensitive activation material.
- Make trial identity less resettable than a single editable JSON file.
- Add restart-boundary tests for active, expired, locked, and tiered states.

### LX-07 Backup and restore hardening

- Restore into a staging directory first.
- Take a rollback snapshot before replacing live data.
- Use atomic rename where possible.
- Replace delete-then-copy iCloud sync with sync-into-temp then swap.
- Add interruption and partial-failure tests.

### LX-05 Dictation parity proof

- Run packaged macOS and Windows benchmark artifacts.
- Validate insertion in the frozen launch app matrix.
- Close or de-scope VS Code, Cursor, HubSpot, Word, and Outlook if they cannot pass the launch bar.
- Record latency, insertion mode, command, snippet, and provider-integrity telemetry in the evidence bundle.

## Exit Rule

Do not launch while any of these remain open:

- LX-03 release secrets and signing
- LX-04 packaged QA matrix
- LX-05 packaged dictation parity evidence
- LX-08 meeting reliability evidence
- LX-10 launch claim freeze
