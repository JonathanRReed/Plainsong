# Changelog

All notable changes to Plainsong are documented in this file.

## [Unreleased] - 0.9.0-beta.3 (in progress)

Two audited fix waves merged on top of the `0.9.0-beta.2` integration
candidate: Electron security hardening, meeting data-integrity fixes, model
currency, sidecar robustness, and a renderer UX pass on Dictation and
Meetings recovery. `package.json` has not been bumped and no `0.9.0-beta.3`
package has been built; this section is a source-level record of what
changed underneath `0.9.0-beta.2`. See `LAUNCH.md` for which qualification
evidence is stale and must be recaptured before this becomes a candidate.

### Added
- **More than one dictation shortcut.** Settings → Shortcuts now holds a list
  of dictation bindings instead of a single hotkey. A binding can be a key
  chord, an extra mouse button (3–5), or a modifier on its own (Fn, Cmd), and
  it can start dictation in the current profile, start it in one named
  profile for that session only, move to the next profile, or cancel. Each
  binding chooses hold-to-talk or press-to-toggle, or follows the activation
  setting. Mouse buttons and lone modifiers need the native shortcut helper
  and say so in the row when it is not running; key bindings still fall back
  to Electron's press-only registration, where hold degrades to toggle as
  before. Existing settings migrate: the old `toggleDictation` key becomes
  the first binding and is kept written for one release so a downgrade still
  has a hotkey.
- **Translate to English, per profile.** A dictation profile (and the
  built-in profiles as a group) can now deliver English whatever language was
  spoken. Multilingual whisper.cpp models translate inside their own decode
  with nothing else running; every other recognizer transcribes in the spoken
  language and the dictation AI provider translates before formatting and
  insert, inside the same timeout the formatting pass gets. A translation
  that fails or times out inserts the words as spoken and says so rather than
  losing them. The switch is disabled with the reason when the model cannot
  translate (`.en` whisper builds) or when no AI provider can answer. The
  language the recognizer detected, the route, and whether the translation
  actually landed are recorded in the dictation history details.
- Onboarding now asks how meeting notes get written: local Ollama (with live
  detection), bring-your-own-key cloud AI, or transcripts only — instead of
  silently defaulting to an Ollama install that usually isn't there.
- Meeting recovery actions that did not exist before: "Re-check audio" on a
  meeting whose audio state looks wrong, "Re-transcribe" plus an explicit
  acknowledge step on an incomplete transcript before its audio can be
  cleaned up, and a "Retry" action on a meeting whose summary/action items
  failed to generate.
- Mid-meeting warnings for a dead WAV writer and a filling disk: new meetings
  are refused up front on a volume without enough free space, a low-space
  warning fires while there's still time to act, and a critical-space
  threshold stops the meeting cleanly instead of writing a truncated file.
- A dictation session left running unattended now auto-stops after 10
  minutes with a truncation warning instead of growing its capture buffer
  without bound.
- An explicit, off-by-default "Also copy every dictation to the clipboard"
  toggle in Settings, with the plain-language caveat that turning it on
  replaces clipboard contents on every dictation and does not restore them.
- Qwen3-ASR 0.6B (int4 ONNX, ~1.9 GiB) is now selectable as an
  experimental local route for dictation and meetings, the only local
  route here to Chinese, Japanese and Korean (30 languages listed
  upstream). It had shipped downloadable but gated off because it was
  never run on real audio; the first run found the mel layout transposed
  and the chat-template prompt missing, both fixed. Validated on English
  real audio (3.7% WER on the 44 s fixture against a Parakeet/whisper
  cross-checked reference). It is not promoted and not the default: the
  int4 decoders run on the CPU at anywhere from a quarter of real time to
  slower than real time depending on load (11-59 s for 44 s of speech on
  an M4 Pro across quiet and shared-CPU runs; provisional), and the route's
  own copy says so. Audio longer than 60 s is decoded in pause-aligned
  chunks, and a decode that would come back truncated is refused.

### Changed
- **The macOS sidecar now ships Candle's Metal backend** (`candle-metal`),
  so the Distil-Whisper and Whisper large-v3-turbo providers run on the GPU
  instead of CPU F32. Measured on an M4 Pro with a combined
  `candle-metal,ort-coreml` dev binary on a loaded shared machine (two usable
  processes): distil-large-v3.5 went from 32.8 s to 0.96 s p50 for a 5.3 s
  utterance; the as-shipped binary itself was not re-measured (a keychain
  prompt blocked it) and a quiet-machine re-run is still owed, so treat the
  figures as provisional. `scripts/sidecar-cargo-features.mjs` is now
  the one list of macOS-only sidecar features, shared by the release build,
  `lint:rust` / `test:rust` / `benchmark:latency`, CI, and the third-party
  notices. The `ort-coreml` CoreML execution provider was measured as well
  and deliberately left out: it regressed Moonshine (24 s first-load
  compile, slower steady state). Receipt:
  `artifacts/qa/acceleration-receipt-2026-09-01.md`.
- The personal dictionary now reaches the recognizer, not only the text
  afterwards. Each dictation builds a vocabulary hint from the dictionary
  entries and plain-word snippet triggers that apply to the app in front
  (same app/category scoping as the replacement pass; newest first; deduped;
  capped at 60 terms / 600 characters; nothing sent when nothing applies) and
  hands it to the provider with the audio: whisper.cpp as the initial prompt,
  OpenAI and Groq as the `prompt` field (both as one framed sentence,
  `Vocabulary: term, term.` — a bare comma list measurably hurt `base.en` on
  the repo fixtures), ElevenLabs Scribe as `keyterms`.
  Snippet expansions and misheard spoken forms are never sent; the prompt
  is capped at an estimated 200 tokens under whisper's window, withheld on
  near-silent or sub-half-second audio, and an output that only echoes the
  hint on quiet or sub-second audio is decoded again without the prompt
  rather than typed as-is. Cohere's
  OpenAI-compatible endpoint documents `prompt` as unsupported, and Parakeet,
  Moonshine, Candle, Qwen3 and Apple Speech have no equivalent, so those
  routes are unchanged. Note for ElevenLabs users: ElevenLabs bills a 20%
  surcharge on any request that carries keyterms, so a non-empty dictionary
  now costs 20% more per Scribe dictation. `benchmark-latency` gained
  `--vocabulary` so the effect can be measured on the fixtures.
- **Parakeet TDT 0.6B v3 is now the default and recommended dictation
  model** (640 MB), because this repo's own benchmark shows whisper.cpp
  `base.en` mis-transcribing words it hasn't seen before — including
  "Plainsong" itself. Whisper `base.en` (142 MB) remains available as the
  smaller-download alternative in first-run setup, and installs that already
  had `base.en` configured keep it and keep getting its background
  auto-download; nothing forces a re-download. The meeting lane's default is
  unchanged.
- **Meeting capture no longer depends on having an AI route configured.**
  Recording, transcript, and playback are judged on capture alone; a missing
  or unconfigured AI provider (e.g. Ollama not installed) now only degrades
  the notes/summary messaging, quietly, instead of disabling "New meeting,"
  the consent dialog, and the dashboard quick action the way it did when
  capture and AI-notes readiness were the same check.
- **Dictation profile tiles no longer silently turn on clipboard copying.**
  Every built-in mode and recommended app style previously set
  `copyToClipboard: true` on selection, which permanently overwrote whatever
  the user had copied on every subsequent dictation. Clipboard copying is
  off by default now and is only ever changed by the explicit toggle above.
- **The dictation language picker reflects what the selected model can
  actually transcribe**, instead of a fixed 7-option dropdown (auto-detect
  plus 6 languages). A multilingual Whisper model now offers its full
  published set (99 languages, 100 with `large-v3`'s Cantonese support);
  Parakeet TDT v3 offers its 25 supported European languages; an
  English-only model states that in a sentence instead of showing a picker.
  Saving a language selection is validated against the selected model's real
  coverage rather than a fixed 12-language allowlist that used to accept
  languages an English-only model couldn't handle and reject languages a
  multilingual model could.
- Recording encryption now streams in fixed 1 MiB frames instead of holding
  a whole track (and its ciphertext copy) in memory, and checks free disk
  space first — if there isn't enough, it defers encryption and keeps the
  recording intact rather than failing the meeting stop.
- Learned dictionary corrections (names, jargon, product names taught via
  the personal dictionary) now apply to meeting transcripts, summaries,
  action items, and auto-generated titles, not only to live dictation.
- Custom dictation mode prompts are now honored when built on the Messages,
  Email, or Meeting Follow-up presets, not only on the default preset.
- Systemwide text insertion at the end of a dictation now runs off the async
  runtime, removing an up-to-one-second stall it previously caused elsewhere
  in the app.
- Disk-space thresholds for an in-progress meeting are now sized to how
  many audio tracks that meeting actually writes (microphone-only vs.
  microphone-plus-system-audio) instead of one fixed byte budget that
  refused or warned mic-only meetings too early.
- Model currency: the Gemini analysis default is now `gemini-3.7-flash`; the
  OpenAI analysis default is `gpt-5.6-luna`; the DeepSeek default is
  `deepseek-v4-flash`; the Ollama default is `qwen3.5:4b` (matching the
  Settings empty-state hint, which also now suggests `ollama pull
  qwen3.5:4b`); the OpenAI cloud dictation default is `gpt-transcribe`
  (meeting-lane OpenAI transcription stays pinned to `whisper-1`, the only
  OpenAI cloud model that returns the segment timestamps meetings need); and
  the ElevenLabs default is `scribe_v2` (`scribe_v2_realtime` was
  websocket-only and could never work through this app's upload path).
  Context-window budgeting now recognizes GPT-5.x and Gemini-3.x models'
  real ~1M-token windows instead of clamping them to a stale estimate.
- The stored meeting-lane default now names the route the meeting lane
  actually runs: `parakeet` / `parakeet-tdt-0.6b-v3`. It was stored as
  whisper.cpp `base.en`, but whisper.cpp has never been a meeting-supported
  provider, so that slot was never read and every fresh install already
  transcribed meetings with Parakeet. A settings file still carrying the old
  `whisper`/`base.en` meeting pair is rewritten to Parakeet on load; shared
  dictation/meeting selection is untouched. No transcription behavior
  changes; the settings file stops claiming a route that never ran.
- The unused `toggleDictationAlternates` shortcut key is gone from the
  settings schema (it was only ever written as an empty list). Old settings
  files that still carry it load cleanly and are rewritten without it.

### Fixed
- The wait in front of an insert is now capped once, not once per pass. A
  dictation that both translates to English and then formats used to take a
  full formatting timeout for each, so the real worst case before a word
  appeared was twice the stated budget (12 s on the local split). Both passes
  now share one budget; whatever the first spends is taken off the second.
- Translate to English no longer runs a hidden AI pass on an English-only
  whisper model. Turning the switch on under a multilingual model and then
  switching to a `.en` build left the setting stored as on while the switch
  showed off and disabled, so every English dictation paid for a second model
  call before insertion. The stored flag (built-in profiles and each saved
  profile) is now cleared on save, and the runtime route refuses the case
  independently.
- A mic failure mid-meeting in a "me and them" (microphone plus system
  audio) recording is now detected and noted on the meeting instead of being
  silently padded with silence and presented as a complete recording; a
  replugged microphone can recover without ending the meeting.
- A meeting whose Stop step failed for an unrelated reason after its audio
  was already safely written no longer has that audio condemned — it stays
  usable, and the app can self-repair such meetings on next launch.
- Stopping a meeting can no longer hang indefinitely behind a background
  storage sweep; capture now ends within about 10 seconds regardless.
- Storage-retention cleanup no longer deletes the source audio of a meeting
  whose transcript came out incomplete until the user explicitly
  acknowledges the loss (or it's successfully re-transcribed).
- A mid-meeting warning banner no longer erases the live transcript preview,
  the elapsed timer, or the lost-audio counter already on screen.
- Retired the non-functional "macOS MLX sidecar (advanced)" dictation
  engine: its download step only ever wrote a stub marker file, so selecting
  it always failed transcription. It no longer appears in Settings, and
  installs that had it selected are moved off it automatically.
- A panic in one background worker (a WAV writer, a transcription task, an
  audio callback) no longer takes down the whole local transcription
  process; that one component fails and the rest of the app keeps running.
- Downloaded model integrity receipts are now HMAC-protected with a
  keychain-held key rather than a plain hash, and an accidentally-empty
  pinned digest can no longer silently disable verification of a downloaded
  model file.
- A manual "Retry" on meeting analysis can no longer run alongside an
  automatic analysis pass for the same meeting, and the capture-admission
  check introduced in the prior wave is now actually enforced rather than
  decorative.
- Sidecar-loss and meeting-start failures now show one plain-language
  message and one action instead of a raw process-exit log line or generic
  advice glued onto an unrelated error (for example: "Plainsong does not
  have microphone access, so there is nothing to record" with an "Open
  Microphone settings" action, distinct from a system-audio or disk-full
  failure). A capture source that hard-fails is now described as failed,
  not as having "gone silent," which previously read as a muting problem.

### Removed
- The never-reachable "post the consent notice into the meeting chat for
  you" automation for Zoom and Google Meet. Its keystroke senders sat behind
  a gate that was hard-wired to off because nothing could prove the meeting
  app's chat field had focus, so no build ever sent a notice. The start
  sheet, the recording popup, and the beta docs now say plainly that
  Plainsong does not post the notice; the notice text and its Copy button
  stay. Automation can only come back with a positive focus-verification
  design and on-device QA.
- The ML punctuation/casing model (`punct_cap_seg_en`, ~210 MB) and the
  `text-recasepunct` build feature. Its restore function had no caller, and
  every shipped speech route already emits punctuated, cased text (see
  docs/model-inventory-upgrades.md item 9 for the per-route table), so the
  download existed to fix a problem no route has.

### Security
- Dictation now refuses to deliver into password boxes and other secure
  inputs. Before the direct Accessibility write, before the clipboard +
  Cmd+V fallback, and before the Cmd+C used to read a selection, the sidecar
  checks the focused control (`AXSecureTextField` role/subrole), letting
  macOS's system-wide secure-event-input flag decide only when the control
  cannot be inspected; when the check says "secure", nothing is inserted,
  nothing is staged on the clipboard (clipboard-only mode included), the
  words stay in dictation history, and the popup reports the distinct
  `secure_field` outcome in plain language with the Copy action still
  available. The paste fallback re-probes immediately before it touches the
  clipboard, so focus moving between the first check and the paste cannot
  slip a password box in. Previously this was left to whatever the target
  app did with a synthetic paste.
- `shell.openExternal` and in-app link navigation now check a fixed host
  allowlist before opening anything in the user's browser; a link to any
  other host is refused and logged, not opened.
- The dictation and recording overlays can no longer be resized past a fixed
  cap or shown while the user has that overlay turned off; native folder
  dialogs (export, backup, cloud backup) now require a real click or key
  press in the main window; the main window itself rejects unbounded resize
  or move requests; and every `ipcMain` handler now requires a trusted
  top-level frame as its sender.
- The renderer bundle now serves its Content-Security-Policy (including
  `frame-ancestors 'none'`), `X-Content-Type-Options`, and `Referrer-Policy`
  as real headers on every asset the app serves, not only as a `<meta>` tag
  on `index.html`.
- Auto-update now verifies the running app's code signature and Apple
  Developer team before handing off to an installed update, and refuses
  with a manual-download message if either check fails. It previously only
  displayed the signature and rejected exactly the literal string
  `Signature=adhoc`, so any other signature — including one from an
  unrelated Developer ID — passed through unchecked.

### Release infrastructure
- `CFBundleVersion` is now a real integer build number
  (`encodeBundleBuildVersion`, e.g. `900302` for `0.9.0-beta.2`) instead of
  the literal semantic-version string, which macOS has no ordering for.
  `CFBundleShortVersionString` still carries the full semantic version.
- The release DMG now lays out the app icon and an `/Applications` shortcut
  in a sized window instead of Finder's default, unstyled placement.
- macOS entitlements are now split per binary instead of every Electron
  helper process copying the main app's entitlements: the GPU, Renderer, and
  Plugin helpers are narrowed to JIT/inherit only; the generic helper that
  hosts Chromium's audio service keeps audio and nothing else; the sidecar
  and shortcut helper carry no entitlements at all; and
  `com.apple.security.cs.disable-library-validation` has been removed from
  the main app's own entitlements (flagged for packaged-QA verification — if
  a packaged build fails to launch because of this, the fix is to sign the
  offending library, not restore the entitlement).
- The public update feed is now resolved per channel: `/beta/` and
  `/stable/` are separate manifest directories, and the running app
  re-resolves its feed URL from the active channel at check time instead of
  trusting a single URL baked in at build time. A future stable release
  requires publishing `/stable/latest-mac.yml` before stable installs can
  check for updates at all.
- `scripts/build-dmg.mjs` (the local, ad-hoc DMG builder — not the release
  path) now prints an unmissable runtime warning that its output is not a
  release artifact and does not notarize, staple, or apply the release DMG
  layout. The `0.9.0-beta.2` DMG shipped unnotarized because this script was
  used instead of `bun run release:mac`; the warning now prints before and
  after every local build.

## [0.9.0-beta.2] - 2026-08-23 (integration candidate)

This private candidate reconciles the full dual-pillar beta with current
application, Rust, and workflow dependency updates. It repairs exact-candidate
QA receipt wiring, separates measured latency from clean-checkout source gates,
closes release-workflow verification gaps, and fixes validated Dictation and
Meetings lifecycle defects before a new package is qualified.

### Repaired
- QA receipt wiring: aggregators and producers now agree on `release/qa` paths.
- Latency gate: self-sufficient source gate separated from measured receipt.
- Release workflow: license and cold-start gates added; Windows publish-on-tag
  removed.
- Meeting lifecycle: stop failures now surface to the user instead of causing
  unhandled rejections; renderer and main-process lifecycle events reconciled.
- Capture admission: privileged storage operations guarded.
- Electron 43 module resolution: process-scoped imports (`electron/main`,
  `electron/renderer`, `electron/common`) resolved for both runtime and tests.
- `nanoid@3.3.18` security fix applied via package.json override.
- Dependency updates from all three Dependabot branches reconciled.

### Verified locally
- 868 Vitest tests, Rust library and binary tests, IPC contract, dead-code,
  TypeScript, renderer build, Electron build, Rust fmt and Clippy.
- Local package: native helpers, licenses, third-party notices, Electron fuses,
  Developer ID signatures, hardened runtime, secure timestamps, arm64, zip
  extraction, size gate (374 MB), cold-start gate (2428 ms).

No `0.9.0-beta.2` artifact has been notarized, stapled, or distributed. Signing,
notarization, Gatekeeper, clean-install, real-device, and updater claims require
fresh evidence from the exact final revision.

## [0.9.0-beta.1] - 2026-08-08 (historical candidate)

The free, open-source relaunch. The previously commercial app (NautilusBot /
Nautilus) was rebuilt as **Plainsong** — MIT licensed, no trial, no tiers,
no telemetry. This limited beta targets macOS on Apple Silicon (arm64).

Dictation and Meetings are both supported release pillars. The beta adds
explicit runtime readiness, bounded recovery, local-first remote-processing
revocation, guarded privileged storage operations, rollback-resistant beta
updates, and exact-candidate QA receipts. The first invite-limited group accepts
the formal real-device Dictation matrix, remaining Meeting lifecycle rows, and
a repeat three-hour capture soak as documented beta risks. They remain required
before public launch. Distribution still requires explicit approval, and
automatic updates remain gated on the exact-candidate updater journey and
publication of the beta update feed. Its historical receipts do not establish
those states for later candidates.

### Added
- **Hold-to-talk dictation**: true press-and-hold via a native macOS
  CGEventTap helper, with automatic fallback to toggle if the helper is
  unavailable.
- **Hands-free dictation**: voice-activity auto start/stop, with an optional
  Silero VAD (ONNX) model download for higher accuracy than the built-in
  energy-threshold gate.
- **Destination-app-aware AI formatting**: dictation cleanup adapts to the app
  being dictated into (email, messaging, AI chat, code editor, notes), with
  per-app overrides.
- **Voice/palette editing of selected text**: Cmd+K commands (shorten, expand,
  proofread, tone rewrite, translate, and more) that replace the selection in
  place.
- **Live streaming partials**: words appear in the overlay as you speak
  (UI-only; never changes the inserted text).
- **Menu-bar tray** with Open/Quit and a minimize-to-tray setting; multi-monitor
  and notch-aware placement for the dictation/recording overlays.
- **Shortcut-conflict detection** with an inline warning in Settings.
- Dictionary/snippet **category scoping**, a "recently learned" list, and a
  capitalization-only quick action.
- Real dictation latency benchmark (`bun run benchmark:latency`) measured on a
  real spoken-speech fixture (`scripts/fixtures/real-speech-44s.wav`).

### Changed
- **Renamed** end-to-end to Plainsong: bundle id `com.plainsong.app`, sidecar
  binary `plainsong-sidecar`, data directory, and all brand text (pre-launch,
  so no data migration).
- Renderer restyled to the manuscript brand (see `STYLE.md`); themes collapsed
  to two.
- Default local route is whisper.cpp (Metal) `base.en`; hot path
  unblocked (concurrent JSON-RPC dispatch, model pre-warm, in-process
  frontmost-app lookup).

### Removed
- All commercial licensing, trial, nag, and entitlement code.
- Telemetry/analytics: none ship; keys live in the OS keychain; dictation audio
  is never persisted (see `../PRIVACY.md`).

## [Pre-relaunch] - 2026-03-02

Work recorded before the rename to Plainsong; names below reflect the app as it
was then.

### Added
- Added benchmark launch gate verifier (`scripts/verify-benchmark-gates.mjs`) for CP-13/CP-14/CP-15 thresholds.
- Added benchmark gate artifact schema (`docs/ci/schemas/benchmark-gate-result.schema.json`).
- Added owner/evidence placeholders across all packaged QA matrix rows.

### Changed
- Updated release cold-start gate process matcher to target the then-current packaged binary `nautilus-bot` (now `plainsong-sidecar`).
- Updated competitor parity command docs (the project has since standardized on bun).
- Updated release/prelaunch readiness docs with current gate status and blockers.
- Improved artifact validator support for `date-time` formats and regex `pattern`.
- Stabilized the recordings view cross-meeting recall test so it waits for the recall button before clicking ([PR #9](https://github.com/JonathanRReed/Plainsong/pull/9)).

### Security
- Updated lockfile dependencies to remediate Rollup path traversal advisory.
