# Plainsong launch checklist

Release state as of **August 2, 2026**.

An adversarial pre-launch audit on August 2 produced 57 findings across
security, privacy, correctness, data integrity, accessibility and release
engineering. Twenty-six were re-checked by independent reviewers instructed to
refute them; none were refuted. All 57 are fixed on `launch/audit-remediation`,
which is the tree this file now describes. What changed, and why each mattered,
is in the commit messages rather than repeated here.

The three that were stop-ship:

- Meeting route repair could select a cloud ASR provider under a local-first
  policy, because a stored API key was treated as evidence that uploading audio
  was acceptable. Local is now a boundary rather than an ordering.
- `isDev` was `NODE_ENV === "development" || !app.isPackaged`, so an ambient
  environment variable could put a signed build into development mode and point
  its privileged windows at an arbitrary URL. Packaging is now the only input,
  and the missing Electron permission handlers exist.
- The packaged app carried no licence text at all, including the Apache-2.0
  notice that statically linked CPAL requires. All three licence files now ship
  in `Contents/Resources` behind a release gate.

Notarization is **not** blocked and never required CI: the `plainsong-notary`
Keychain profile authenticates on this machine and already holds Accepted
Plainsong submissions from July 30. Earlier revisions of this file said no
authenticated profile existed; that was true when written and is no longer true.
Release builds run locally with `APPLE_KEYCHAIN_PROFILE=plainsong-notary` and
`CSC_NAME="Jonathan Reed (AJ9VWBRNZN)"` — the bare identity name, because
`release-credentials-preflight.mjs` adds the `Developer ID Application:` prefix
itself and rejects a value that already carries it.

This file separates source and local-package completion from the checks that
still need a human present or a public repository.

## Verdict

**Source, notarized package, and Gatekeeper acceptance: ready.
Real-microphone acceptance on this host and public release: deferred.**

The August 2 build is notarized and stapled, and Gatekeeper accepts both the app
and the DMG with `source=Notarized Developer ID`. That was the last gate that
needed Apple, and it did not need CI.

What remains is not a signing problem. It is: a real-microphone meeting pass on
this host, a clean-Mac install and permission pass, an N-to-N+1 updater install
through a published feed, broader target-app insertion coverage, the physical
hold-to-talk and hands-free tests no script can close, making the release
repository public so the updater feed is reachable, and publication itself.
Do not describe v1.0.0 as launched until every item under "External release
gates" is complete.

### The August 2 notarized artifacts

Built from `launch/audit-remediation` with the audit remediation in place.

- App: 375 MB, CDHash `b37da484d7f23f3fecddf9634530bdb98e0de5a4`
- DMG: 162,860,921 bytes,
  SHA-256 `feb800ffd8fd802a00050cdd04931d9901c9e8559f8e4a4e136493bd73b11985`
- ZIP: 142,678,113 bytes,
  SHA-256 `1cf86ed0275dc43228111e68750bf64153b4d3c811991e3edea287c30e54f101`
- `latest-mac.yml`: 355 bytes,
  SHA-256 `20c7eccf6baa3f054b71879df75f3b2ecb241f796eb5fd2ef68812542d9c7231`
- ZIP blockmap: 152,388 bytes,
  SHA-256 `df8e1c9350c87d183380cd05bf80f000b9635409a1457a0533d5d0f84a9cd1ea`

The DMG hash is the stapled artifact. Stapling rewrites the file after
electron-builder finishes, which is why `dmg.writeUpdateInfo` is false and the
DMG is covered by its own checksum rather than by `latest-mac.yml`.

Gates run against this exact package:

| Gate | Result |
| --- | --- |
| `gate:release:macos:trust` | **PASS**, 102 of 102 checks, exit 0 |
| Gatekeeper, app | accepted, `source=Notarized Developer ID` |
| Gatekeeper, DMG | accepted, `source=Notarized Developer ID` |
| `stapler validate`, app and DMG | ticket present on both |
| `gate:release:licenses` | PASS — LICENSE, THIRD-PARTY-NOTICES.txt, LICENSES.chromium.html all present in `Contents/Resources` |
| `gate:packaged:macos:native` | PASS, arm64 across every native executable |
| `gate:size` | PASS, 375 MB against the 450 MB gate |
| `qa:packaged:macos:update-metadata` | PASS, manifest SHA-512 and size match the built ZIP |
| `gate:cold-start` | PASS, 986 ms against the 2,500 ms gate, isolated profile |

The trust gate needs `APPLE_TEAM_ID=AJ9VWBRNZN` in the environment. Without it
four of its 102 checks fail closed on "no expected team configured" — which is
the gate behaving correctly, not a signing fault, but it is easy to misread as
one.

The app grew from 351.96 MB to 375 MB. Most of that is the third-party licence
material the binary is now obliged to carry, and it is well inside the gate.

## Verified source gates

- [x] Frozen Bun install.
- [x] TypeScript typecheck for renderer and Electron projects.
- [x] Renderer and Electron test suite: 70 files and 716 tests pass.
- [x] Rust library and operator-binary test suites: 680 tests pass and 5
      documented hardware/model-dependent tests are ignored.
- [x] Rust formatting and clippy with the locked dependency graph.
- [x] IPC contract in both directions: 168 renderer commands, 222 sidecar
      commands, and 157 dispatched commands are reachable.
- [x] Dead-code hygiene through pinned Knip and the repository gate.
- [x] Renderer, Electron main process, Rust sidecar, native shortcut helper,
      and Apple Speech helper build.
- [x] Required local ASR asset preflight: Whisper, Parakeet TDT v3, and
      Distil-Whisper are ready with no required-provider failures.
- [x] Operator latency benchmark validates options before model loading,
      records fixture identity and all timed runs, and uses the conventional
      real-time-factor definition. Real Whisper `base.en` evidence on the
      43.97-second spoken fixture measured 599 ms p50 and 640 ms p95 across
      five runs, or 73.4 times real-time.
- [x] Dependency audit reduced from 36 findings to one reviewed
      `brace-expansion` advisory in build and test tooling. The release gate
      proves the top-level package is patched, no additional advisory exists,
      and no affected package ships in the app.

## Verified local package

- [x] `nautilus-bot/release/mac-arm64/Plainsong.app`, notarized and stapled.
- [x] `nautilus-bot/release/Plainsong-1.0.0-arm64.dmg`, notarized and stapled.
- [x] `nautilus-bot/release/Plainsong-1.0.0-arm64-mac.zip`.
- [x] ZIP blockmap and `latest-mac.yml`.
- [x] 375 MB app size, below the 450 MB gate. The rise from 351.96 MB is the
      bundled third-party licence material.
- [x] arm64 app and every native executable.
- [x] macOS 13.0 deployment floor in bundle metadata, sidecar, shortcut
      helper, and Apple Speech helper.
- [x] Microphone, system-audio capture, and Speech Recognition usage strings.
- [x] App, sidecar, shortcut helper, Speech helper, and DMG use Developer ID
      Application signing for team `AJ9VWBRNZN`.
- [x] Hardened runtime and secure timestamps on executable code.
- [x] Shortcut helper has an empty entitlement set.
- [x] Apple Speech helper has only the Speech Recognition entitlement.
- [x] Update manifest SHA-512 and size match the generated ZIP.
- [x] Electron fuses disable RunAsNode, NodeOptions, Node CLI inspection, and
      privileged `file://` behavior. ASAR integrity and ASAR-only loading are
      enabled.
- [x] The packaged renderer uses the restricted
      `plainsong://bundle/index.html` origin with path containment checks.
- [x] The exact packaged app reaches renderer readiness through
      `plainsong://bundle/index.html` against an isolated empty profile.
- [x] The renderer payload shipped in the exact package was inspected live
      through the macOS accessibility tree and screenshots in the immediately
      preceding signed bundle. The final package contains the byte-identical
      `dist/` payload. It renders the explicit model download, in-app
      first-dictation test, system-wide setup, and final readiness summary.
      Completing all three stages without choosing Download created no model
      files, recordings, or transcripts.
- [x] The packaged onboarding focus trap starts at Download, wraps backward
      from Download to Continue, supports a keyboard-only skip, and then exposes
      a working skip link that focuses the named Dictation workspace.
- [x] The packaged Meetings shortcut focuses the named Meetings workspace.
      Starting without a meeting-grade route redirects to the focused Settings
      workspace with the actionable route error instead of beginning capture.
- [x] The current package includes bounded microphone-preparation retirement,
      prevents another microphone retry from joining a stalled worker, and
      recycles the Electron sidecar only for the matching dictation or meeting
      preparation timeout. The Rust and Electron recovery tests pass.
- [x] Sidecar shutdown rejects pending and new renderer calls before closing
      stdin and consumes the expected pipe-close event. The packaged app
      completed a real SIGTERM shutdown with sidecar exit code 0 and no
      uncaught `EPIPE`.

The superseded July 30 preflight produced a 351.96 MB unnotarized app with CDHash
`557a50446a500d8cb995203f24e029102b8ed3a5`. Its hashes are not repeated here:
the August 2 notarized package above is the candidate, and carrying two sets of
checksums in one file is how the wrong one ends up in a release note.

That July 30 package reached renderer readiness in 1,229 ms and completed an
isolated live onboarding inspection leaving zero recordings, transcripts, audio
assets, or model files behind. The August 2 notarized package repeats the
cold-start result at 986 ms.

The August 2 DMG verifies with `hdiutil`. Its mounted `Plainsong.app` has the
same CDHash, `b37da484d7f23f3fecddf9634530bdb98e0de5a4`, as the directory
package, which proves the disk image contains the exact notarized candidate
documented above.

The packaged ASAR is byte-for-byte identical to the current `dist/` and
`dist-electron/` output. After removing the linker ad hoc signature and the
packaged Developer ID signature from disposable sidecar copies, `cmp` reports
only the two-byte `__LINKEDIT` virtual-size adjustment created by the different
signature sizes. All executable and data payload bytes match.

## Packaged QA completed in this run

The package identity, metadata, size, dependency, renderer, and cold-start rows
below were rerun against
`release-plainsong-launch-candidate-20260730`. Audio and
target-app rows retain their exact earlier artifact scope where noted. They
must not be treated as proof for the final notarized identity until the
remaining reruns are complete.

| Check | Result | Scope |
| --- | --- | --- |
| native helper/package gate | pass | Presence, arm64 architecture, deployment floor, entitlements |
| update metadata | pass | Version, ZIP, blockmap, size, SHA-512 |
| size gate | pass | 351.96 MB of 450 MB maximum |
| component smoke | pass | Sidecar, permissions diagnostics, insertion components, setup checks |
| local Whisper fixture | pass | Nonempty transcript, one model load, clean sidecar exit |
| retention | pass | Transcript-only, audio-only, and audio-plus-transcript policies |
| backup and restore | pass | Local create/restore plus explicit iCloud-provider sync/restore path |
| exports | pass | Markdown, JSON, text, all seven templates, database restore, fixture cleanup |
| packaged renderer | pass | The launch-ready package emitted `App rendered` through the production protocol against an isolated empty profile |
| cold start | pass | Current launch archive emitted `App rendered` in 1,229 ms against a 2.5 s gate without touching live data |
| dictation hotkey | pass | Packaged global shortcut, microphone capture, Whisper transcript, clipboard delivery |
| Apple Notes insertion | pass | Real packaged insertion into Notes, including native-paste fallback and bundle-ID evidence |
| microphone meeting | host rerun required on exact artifact | The immediately preceding signed candidate captured real mic audio and passed lifecycle/restore checks. After the BlackHole fault injection, both Plainsong and independent FFmpeg/AVFoundation capture block in the host audio stack; the exact artifact now exits safely instead of hanging |
| bounded microphone preparation | pass | A deliberately blocked BlackHole input returns `Timed out waiting for microphone stream preparation` in 2.078 seconds. The direct sidecar remains responsive, and the harness restores system output, database, settings, and audio files |
| app-level microphone recovery | prior signed candidate pass | The audio-rollback package surfaced focused recovery copy in 4.267 seconds, replaced sidecar PID 92155 with 94375, left the isolated meeting database at zero rows with no audio files, and restored live input, output, and meeting settings |
| bounded system-audio recovery | pass | The worker returned an actionable 70-second permission timeout and the same packaged sidecar then answered a `get_settings` health probe |
| system-audio known tone | permission blocked on current artifact | An earlier candidate captured the 997 Hz fixture; the exact current candidate requires its new Screen & System Audio Recording grant before rerun |
| combined meeting capture | rerun required on current artifact | The earlier candidate produced mic, system, and mixed WAV output; rerun after granting the current candidate system-audio permission |
| meeting soak preflight | lifecycle pass, spoken fixture fail | The strengthened fixture matcher rejected the low-information transcript `you`; capture, transcription lifecycle, cleanup, database restore, and settings restore passed |
| local Ollama analysis | pass | `gpt-oss:20b` summary and action items with grounded citations |
| idle CPU | pass | 0.45% average, 5.7% maximum, 2% p95, clean exit. Was 0.05% / 0.9% / 0.1% on Electron 42 — see below |
| release trust | expected fail | Every local signature check passes; notarization checks fail closed |

### Idle CPU rose on Electron 43 and still passes

Average idle CPU went from 0.05% to 0.45% against a 1% gate, with the maximum
moving 0.9% -> 5.7% and p95 0.1% -> 2%. The gate passes and 0.45% is still low
in absolute terms, but it is a nine-fold move and the only change between the
two measurements is the July 28 dependency group, of which Electron 42 -> 43 is
the plausible cause. Recorded rather than rounded away: if it climbs again on a
future bump, the gate is close enough to matter, and the number to compare
against is this one, not the 0.05% it replaced.

### First launch after a build is not a representative cold start

The exact launch archive passed an isolated fresh-profile launch at 1,229 ms.
The previous audio-recovery archive passed at 1,696 ms. The earlier
launch-ready archive passed at 1,231 ms. The
audio-rollback archive passed at 1,226 ms. The previous
durable-dictation archive passed three launches at
1,349 / 857 / 855 ms. The previous dependency-refresh archive had one
first-profile miss and then passed at 1,342 / 971 / 971 / 1,210 ms. A July
28 build showed the same pattern: its first launch exceeded the 2,500 ms gate,
then the next four were 1,118 / 853 / 970 / 1,334 ms. macOS validates the whole
351 MB signature once and caches the result, so the first number includes
signature validation rather than measuring renderer readiness alone.

This matters twice. Run `bun run gate:cold-start` a second time after any
release build before believing a failure. And expect real users to pay that
cost once on first launch, because their first launch is also a first launch —
the gate does not measure what they will feel on day one.

### Dependency audit has one build-only exception

The dependency refresh reduced `bun audit` from 36 findings to one high
advisory, `GHSA-mh99-v99m-4gvg`, against transitive `brace-expansion` copies.
The top-level copy is patched at 5.0.8. The five older copies belong to
Electron packaging and development utilities, and none appear in the packaged
ASAR or unpacked resources.

`bun audit` still exits 1, so this is not described as a clean audit. The
`gate:release:dependencies` command permits only this exact advisory and these
reviewed lockfile paths, then scans the exact packaged app. Any additional
advisory, affected runtime copy, or lockfile drift fails the release. See
`nautilus-bot/docs/security/DEPENDENCY_AUDIT.md`.

The retention, backup, and export harnesses restore the original database and
settings after each run. The export harness tests the supported plain export
contract. The old signed evidence-bundle feature was intentionally removed in
June and is not a v1 feature.

## Completed product corrections

- [x] The packaged renderer no longer opens a blank
      `chrome-error://chromewebdata/` window when privileged `file://` behavior
      is disabled.
- [x] Meeting retranscription reaches the shared post-processing pipeline and
      is protected from retention or reset races.
- [x] Recording completion is persisted before optional diarization work.
- [x] Dictation completion creates its recording and transcript in one SQLite
      transaction before native cursor delivery begins. Persistence failure
      rolls back both rows, leaves the recognized words visible, and does not
      claim that text was inserted.
- [x] Reset refuses to purge database content when owned audio deletion fails.
- [x] Retention and legacy cleanup delete only regular files under approved
      app-owned roots.
- [x] Backup creation, validation, and restore reject nested symlinks.
- [x] OpenAI refusals and Gemini safety blocks are surfaced as policy errors.
- [x] Gemini responses retain the provider-reported model version.
- [x] Streaming transcript auto-scroll no longer produces unhandled browser
      errors.
- [x] Sidecar shutdown releases Whisper and runtime state cleanly instead of
      exiting while Metal contexts are still live.
- [x] Concurrent Whisper prewarm, preview, and final decode paths share one
      per-model load gate instead of constructing duplicate Metal contexts.
- [x] Meeting consent delivery is manual and fail-safe in v1. The app does not
      toggle a meeting chat or press Send without proving the intended field
      has focus.
- [x] Visible placeholder shortcut controls were removed. Only working
      shortcuts remain in Settings.
- [x] First run is dictation-first. Users can explicitly download the local
      model, test dictation inside Plainsong before granting system-wide
      insertion access, review the shortcut, and finish with a readiness
      summary. Skipping or advancing does not silently download 142 MB. A
      failed requested download remains visible, blocks a misleading Ready
      completion, and can be retried in place.
- [x] The app shell has a working skip link, named and focusable workspace
      main region, route-change focus, a live route announcement, and alert
      semantics for top-level errors.
- [x] The recording overlay exposes pressed state, live capture and copy
      status, visible focus treatment, and returns focus to the control that
      opened its dialog.
- [x] Competitive positioning was rewritten using current first-party sources
      and no longer contains unsupported allegations or stale uniqueness
      claims.
- [x] Native helper packaging verifies both usage strings and the least-
      privilege entitlement split.
- [x] Ollama structured analysis uses the documented chat endpoint, which
      returns `gpt-oss` structured output in assistant message content.
- [x] Combined and soak meeting harnesses verify the system-audio known tone
      before setup and recording in the same sidecar session.
- [x] Meeting soak QA requires distinctive words from the known spoken fixture;
      any nonempty transcript is no longer accepted as proof that the fixture
      reached the microphone.
- [x] Microphone stream preparation and abort cleanup use bounded thread joins.
      A Core Audio or virtual-device stall now returns an actionable error
      instead of freezing the sidecar indefinitely.
- [x] The app-matrix insertion harness recognizes known target bundle IDs when
      macOS omits the application name.
- [x] The cold-start gate measures real packaged renderer readiness and stops
      the launched process after evidence is captured.
- [x] Cold-start QA now isolates Electron state, sidecar data, and sidecar
      config. Absolute path overrides fail closed, and regression tests prevent
      a QA launch from reconciling or changing a live recording.

## System-audio support

Plainsong prefers native Core Audio process-tap capture on supported macOS
14.7 or later systems. The implementation resolves the newer Core Audio
symbols dynamically so the macOS 13 app can still launch. A virtual loopback
device remains the compatibility path on macOS 13 and earlier macOS 14
versions.

An earlier packaged native process-tap route passed a real known-tone capture
on this Mac. It produced 247 callbacks, 106,479 non-silent frames, and detected
the 997 Hz fixture. A same-session Me + Them recording then produced
microphone, system, and mixed WAV files.

The bounded verifier is present in the current source and launch-ready
package. On the preceding audio-rollback package, with system-audio permission
unresolved, the disposable worker exited at its 70-second safety deadline and
returned an actionable privacy-settings message. The long-lived packaged
sidecar immediately answered a second `get_settings` RPC, proving the
permission stall no longer freezes the application. The known-tone, timeout,
and combined-capture passes must be repeated after granting the launch-ready
candidate Screen & System Audio Recording permission.

The microphone preparation path is independently bounded. On the preceding
audio-rollback package, selecting
`BlackHole 2ch` as the meeting input reproduced a Core Audio
stream-construction stall, but the packaged sidecar returned the typed
preparation-timeout error in 2.078 seconds. The harness restored the original
speakers, database, settings, and audio files, and the same sidecar answered a
health probe.

That audio-rollback package was then tested through the real interface with an
isolated empty database. It surfaced the focused automatic-recovery message in
4.267 seconds, recycled sidecar PID 92155 to PID 94375, and left zero meeting
rows and zero audio files. A failed activation with no captured frames is now
rolled back instead of publishing a header-only failed meeting. The isolated
test profile was moved to Trash after the proof, and the live input, output,
meeting override, and three existing recordings were restored unchanged.

After the fault injection, the host also blocks an independent
FFmpeg/AVFoundation attempt to open the built-in microphone. Plainsong
continues to fail safely, but a Core Audio service or machine restart is
required before the exact-artifact real-microphone pass can be repeated. The
previous signed candidate passed the same real-mic lifecycle before the host
entered this state.

## External release gates

### Apple notarization is complete

Done on August 2 on this machine. The `plainsong-notary` Keychain profile
authenticates, electron-builder notarized the app during packaging
("notarization successful"), and the DMG was submitted separately
(`4dfe20cf-c5a1-4587-bcc3-f6af95f8256a`, Accepted) and stapled. Both artifacts
now pass Gatekeeper as `source=Notarized Developer ID`.

- [x] Confirm a Developer ID identity is available.
- [x] Authenticated `plainsong-notary` Keychain profile.
- [x] Credentialed build with `APPLE_KEYCHAIN_PROFILE` and `CSC_NAME`.
- [x] `bun run gate:release-credentials:preflight` reports `ready: true`.
- [x] Submit and staple the signed DMG.
- [x] `bun run gate:release:macos:trust` passes for the app, DMG, and
      ZIP-contained app with `source=Notarized Developer ID`.

The release workflow is not required for this. It remains the right path once
Actions are available again, because a CI build is reproducible in a way a
developer's machine is not — but it is no longer what stands between this
candidate and a publishable artifact.

See `nautilus-bot/docs/APPLE_DEVELOPER_SETUP.md` and
`nautilus-bot/docs/CODE_SIGNING.md`.

### GitHub Actions is out of minutes

The account has no Actions minutes available, so no workflow can run. This is a
billing and quota state, not a repository or code problem.

It no longer blocks the release, because notarization was completed locally. It
does mean CI has not verified any commit on this branch, so the evidence for
`launch/audit-remediation` is the local gate run recorded above: typecheck, 716
renderer tests, 680 Rust tests, clippy with `-D warnings`, the IPC contract
gate, and the dead-code gate, all green on the same tree that produced the
notarized artifacts.

Restore Actions before relying on any green check, and before treating a future
commit as verified. The workflows now pin every action to a full commit SHA and
run `cargo test --lib --bins`, matching the local command; neither change can be
exercised until minutes are available.

### The updater feed is not customer-reachable

The configured updater provider is GitHub repository
`JonathanRReed/Plainsong`. A July 30 API refresh confirms that repository is
private and has no releases. The packaged update metadata is internally
consistent, but an
unauthenticated customer installation cannot fetch a private GitHub release
feed. Before publication, either make this release repository public or move
the updater to a public feed and rebuild. Then verify the published
`latest-mac.yml`, ZIP, and blockmap from an unauthenticated machine.

### User-present acceptance

- [ ] On a clean Mac, install from the notarized DMG and confirm Gatekeeper
      opens it without a bypass.
- [ ] Complete first-run microphone, Speech Recognition, Accessibility, and
      system-audio permissions.
- [x] Trigger the packaged global shortcut, capture microphone audio, complete
      local Whisper transcription, and deliver through the clipboard.
- [x] Insert packaged dictation into Apple Notes and verify the exact text in
      the target note.
- [ ] Recover the current host's Core Audio capture state, then record a
      mic-only meeting with the exact current candidate. The immediately
      preceding signed candidate passed real capture, overlay lifecycle,
      persisted audio, cleanup, and database/settings restoration.
- [ ] Grant Screen & System Audio Recording to the exact current candidate,
      rerun the packaged 997 Hz known-tone test, and repeat Me + Them capture.
      The bounded timeout and post-timeout sidecar health probe already pass.
- [ ] Extend insertion coverage to an installed browser and code editor, and
      exercise toggle, hold-to-talk, and hands-free modes on the clean Mac.
      Partially advanced on July 28 — see "Activation modes and insertion
      coverage" below. Browser-process insertion is now proven; the named
      browser rows and both editor rows are not closable by any script.
- [x] Confirm paste-last, copy-last, and open-window shortcuts behave as
      labeled. `bun run qa:packaged:macos:recovery-shortcuts` passes against the
      packaged signed build, carried entirely by external read-backs: the system
      clipboard through `pbpaste`, the pasted transcript read back out of a real
      TextEdit document, and an AX window count going 0 to 1. Still worth a
      repeat on the clean Mac, but the behaviour itself is now evidenced.
- [ ] Verify transcript, summary, action items, diarization enrichment,
      retention, and export on the real recordings.
- [ ] Install an update end to end from the signed ZIP and
      `latest-mac.yml`. **Deliberately not attempted locally — see below.**
- [ ] Recapture public screenshots from the final notarized build.

### Activation modes and insertion coverage

Three harnesses were added on July 28. What they establish, and what they
deliberately refuse to claim:

| Run | Result | What it means |
| --- | --- | --- |
| `qa:packaged:macos:recovery-shortcuts` | pass | paste-last, copy-last, and open-window all evidenced externally |
| `qa:packaged:macos:dictation-hotkey` | pass | toggle activation, unchanged from the previous evidence |
| `qa:packaged:macos:dictation-hotkey:hold` | blocked | see below |
| `qa:packaged:macos:dictation-hotkey:hands-free` | blocked | see below |
| app-matrix insertion, Chrome, local probe | pass, out of scope | browser-process insertion proven; closes no matrix row |

**The insertion harness no longer accepts an attestation.** Its pass used to be
three self-reports ANDed with a typed human answer, and only that answer spoke
to whether text landed anywhere. `pasted: true` was never a confirmation —
`paste_text_systemwide` returns it as soon as `CGEvent::post` returns, and
`CGEvent::post` returns nothing. The pass is now carried only by reading the
target surface back, with a pre-insert measurement so pre-existing text cannot
masquerade as an insert, and the verifier rejects any artifact that puts the old
self-reports back into `checks`.

**Hold-to-talk is blocked, not failing.** The native helper stayed alive and an
8-second synthetic `CGEvent` hold was posted, but the app logged no shortcut
signal. From outside the process there is no way to tell "the event never
reached the app" from "the app ignored it", so the harness stops. It explicitly
does not accept the toggle fallback as a hold-to-talk pass — that fallback is
what a degraded run looks like, and counting it would be the exact false pass
this file exists to prevent. Closing this needs a physical `Cmd+Shift+Space`
hold on a Mac where the packaged app holds Accessibility.

**Hands-free is blocked for a different reason.** The fixture plays through the
speakers, and no external check can prove the microphone heard it. A VAD failure
is therefore indistinguishable from muted output, headphones, or an input device
that cannot hear the speakers. It needs someone to speak into the microphone.

**The browser and editor rows cannot be closed by a script at all.** The matrix's
only browser rows are Google Docs and HubSpot, both of which require a
signed-in account. VS Code, Cursor, and Notion are not installed, and DA-001 /
DA-002 additionally demand command-mode and long-utterance evidence that a
single-string paste cannot produce. A Chrome run against a local probe page
reports `PASS_OUT_OF_SCOPE`: every external check passed, so insertion into a
browser process is genuinely proven, but the probe page is not Google Docs and
the artifact says so instead of closing the row.

### Why the updater test is deferred rather than run locally

A local N-to-N+1 install is mechanically possible: build a 1.0.1 candidate with
the same Developer ID, serve `release/` from `127.0.0.1` with
`-c.publish.provider=generic`, and let Squirrel swap the bundle. It was not run,
and the reason is that **it would pass for the wrong reason.**

Locally built fixtures carry no `com.apple.quarantine` attribute, so Gatekeeper
never assesses them the way it assesses a downloaded DMG. An unnotarized swap
between two locally built bundles therefore succeeds regardless of whether the
real path works. The app's own install gate agrees with this reading: `main.ts`
sets `updateInstallBlockedReason` from `isMacAppCodeSigned()` alone, which these
candidates satisfy while remaining unnotarized.

What such a run *would* prove — manifest parsing, version comparison, channel
resolution, download, and the Squirrel swap — is either already covered by
`bun run qa:packaged:macos:update-metadata` (which validates the manifest,
SHA-512, and size against the built ZIP, and passes) or is the part least likely
to differ once notarized.

So this box stays open on purpose, and it should be closed the first time it can
be closed honestly: install the notarized 1.0.0 DMG on a clean Mac, then take a
notarized 1.0.1 through the published feed.

## Publication sequence

The audit remediation is committed on `launch/audit-remediation` as nine
reviewed commits. Nothing has been pushed, tagged, or published.

- [x] Review and commit the working tree.
- [ ] Push the reviewed branch.
- [ ] Create and push the `v1.0.0` tag.
- [ ] Let the release workflow create a verified draft release — or, while
      Actions has no minutes, publish the locally notarized artifacts recorded
      above and attach their checksums by hand. Prefer the workflow once it can
      run: a CI build is reproducible in a way this machine is not.
- [ ] Review checksums, release notes, and clean-Mac evidence.
- [ ] Publish the repository and draft release only when intended.
- [ ] Verify the public DMG, ZIP, blockmap, update manifest, and updater URLs.
- [ ] Point the website download links at the verified public assets.
- [ ] Submit a Homebrew cask only after the notarized DMG is public.

## Public claims until launch

- Apple Silicon, macOS 13 or later.
- Local transcription is the default. Cloud providers are optional and use
  credentials supplied by the user.
- Native system-audio capture is preferred on supported macOS 14.7 or later
  systems. Older supported systems use a virtual loopback compatibility path.
- Meeting completion is saved before best-effort diarization enrichment.
- No public download or shipped release exists until notarization and
publication are complete.
