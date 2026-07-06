# Launch checklist

Honest state of launch readiness for Plainsong. Everything that can be verified
without a physical machine + microphone is done and green; the rest is listed
explicitly so nothing is assumed.

## Done (verified in-repo)

- **Free & open-source**: all commercial licensing/trial/nag/entitlement code
  removed; MIT LICENSE present.
- **Compiles & passes CI gates**: `cargo clippy -D warnings` clean, 292 Rust
  unit tests, 265 vitest, typecheck (both tsconfigs), IPC contract, knip,
  rustfmt — all green. CI runs the shipped default feature set + a production
  build.
- **Competitive-parity push (2026-07-06)**: a research-driven pass closing the
  gaps found against Wispr Flow, Willow Voice, Aqua Voice, Superwhisper,
  MacWhisper, Talon, Handy, and Anarlog/Hyprnote:
  - **Destination-app-aware AI formatting**: dictation cleanup now adapts to
    the app you're dictating into (email/messaging/AI-chat/code-editor/notes/
    worklog), matching Wispr Flow's headline differentiator — bundle-id +
    name based, with per-app overrides, fully local/BYOK, degrades to prior
    behavior when disabled.
  - **Real hold-to-talk**: a native `.listenOnly` CGEventTap Swift helper
    (rides the existing Accessibility grant, no new permission prompt) gives
    true press-and-hold, with Electron's toggle-only path kept as an automatic
    fallback if the helper is unavailable or crashes.
  - **Hands-free / VAD activation**: auto-stop dictation after sustained
    silence (any activation mode) and auto-start on sustained speech when
    hands-free is enabled — a streaming energy-threshold gate, no ONNX
    inference in the hot path.
  - **ASR provider naming/copy fixed**: the module that was internally named
    as if it implemented NVIDIA's Canary model (it's actually a second
    Whisper backend via Candle) was renamed; route-picker copy now states the
    real tradeoff instead of vague "experimental" language.
  - **Dictionary/snippets gained category scoping**, a "recently learned"
    list, and a capitalization-only quick action.
  - **Voice/palette editing of selected text**: select text in any app,
    invoke a Cmd+K command (shorten/expand/proofread/tone-rewrite/translate/
    bulletize/case-transforms/etc.), have it replaced in place — mined from
    an abandoned branch, adapted and hardened rather than merged wholesale.
  - See `[[project-nautilusbot-oss-relaunch]]` memory for the full research
    citations and per-phase engineering notes.
- **Fast default route**: whisper.cpp (Metal/CoreML) `base.en`; measured
  ~137 ms p50 / ~218× real-time on Apple Silicon via `bun run benchmark:latency`.
- **Hot path unblocked**: concurrent JSON-RPC dispatch, model pre-warm on start,
  in-process frontmost-app lookup (no osascript spawn), reduced insertion sleeps.
- **Live streaming partials**: words appear as you speak; UI-only and safe by
  construction (never changes the inserted text); hardened by a 4-reviewer pass.
- **Honest UI**: no fabricated stats, no dead shortcuts, dictation-first default.
- **Privacy by architecture**: no telemetry, keys in OS Keychain, dictation
  audio never persisted; documented vs competitors in PRIVACY.md.
- **macOS TCC**: `NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription`
  added to the packaged Info.plist (without these macOS kills the app on mic use).
- **Renamed to Plainsong** end-to-end (bundle id `com.plainsong.app`, data dir,
  binary `plainsong-sidecar`, all brand text); pre-launch so no data migration.
- **Release pipeline**: electron-builder workflow that signs/notarizes when the
  secrets are present and otherwise publishes an unsigned build. macOS is
  **arm64-only for v1** (the Rust sidecar is host-arch; Intel needs per-arch
  cross-compiles — tracked).
- **Packaged build verified as of 2026-06-13** (STALE — see known gap below):
  `electron:build:mac` produced `Plainsong.app` with bundle id
  `com.plainsong.app`, both TCC usage strings in the Info.plist, and the
  arm64 `plainsong-sidecar` bundled in `Resources/sidecar/` at that time.
- **Honest hotkey UI**: onboarding still defaults to **toggle**; hold-to-talk
  is now a real, selectable option in Settings, gated on a runtime check that
  the native helper is actually running (never offered as a dead choice), and
  hands-free is a real, independent option (no native-helper dependency).
- **App icon**: a real designed Plainsong mark — a gilt-gradient versal “P” on a
  candle-lit ink folio (Baskerville), regenerated at every size into
  `build-resources/icon.icns` / `.ico` / `.png`, plus a black-on-transparent
  menu-bar template icon.
- **Manuscript UI**: the entire renderer was restyled to the Plainsong brand —
  vellum/ink grounds, one gold accent, one rust rubric, Newsreader / IBM Plex
  faces, neume state glyphs (see `nautilus-bot/STYLE.md`). Zero off-palette
  colours; all UI gates green; both themes verified.
- **Multi-monitor + notch HUD**: the dictation/recording overlays now open on the
  display under the cursor, inside its notch-safe work area — not always the
  primary display.
- **Menu-bar tray**: a template-icon `Tray` with an Open / Quit menu (a menu, not
  a popover, per Apple HIG), wired to the `minimizeToTray` setting so the window
  hides to the tray instead of quitting when enabled.
- **HUD dismissal**: the floating HUD persists until explicit dismissal and is
  closed with `Escape` (it never vanishes on click-away).

## Must be validated on a real Mac (cannot be done headlessly)

These are not known-broken — they are simply unproven without a machine + mic.
Expect this pass to surface a couple of small fixes; that's normal.

1. **Produce the packaged build and launch it**: confirm it opens, the bundled
   `plainsong-sidecar` spawns, and a dictation round-trips end to end.
2. **Permissions flow**: grant Microphone + Accessibility on first run and
   confirm dictation captures and inserts into other apps.
3. **First-run model download**: confirm `base.en` downloads and transcribes on
   a clean machine.
4. **Streaming-partials feel**: tune the 700 ms tick / 0.5 s min / 30 s window /
   greedy decode on real speech; it's on by default via Live Preview.
5. **Real-app insertion** across the apps you care about (Slack, browser, IDE,
   Notes).
6. **Menu-bar tray + close-to-tray**: confirm the Tray icon appears, its menu
   opens, "Open Plainsong" reshows the window, and enabling "Minimize to tray"
   hides (not quits) the window on close. (Native — built and typechecked, but
   the runtime behaviour needs a real launch.)
7. **HUD on an external monitor / notched Mac**: confirm the dictation and
   recording overlays appear on the *active* display, not the built-in one, and
   clear of the notch.
8. **Native hold-to-talk feel**: the CGEventTap helper is built, typechecked,
   and unit-tested via its dependency-injected TS facade — but real
   press-and-hold timing/reliability (including the automatic fallback to
   toggle if the helper crashes mid-session) needs a real keyboard.
9. **Hands-free/VAD tuning**: the auto-stop silence threshold (default ~1.8s)
   and auto-start energy threshold are reasonable defaults derived from the
   existing batch VAD's config, but need validation against a real mic in a
   real room (background noise, pause length while composing a sentence).
10. **Destination-app formatting bundle-id list**: the built-in ChatGPT/
    Claude/Cursor/VS Code/etc. bundle-id matches were written from public
    knowledge, not spot-checked against real installed apps on this machine.

## Known gaps (not hard blockers)

- **`nautilus-bot/` directory name** retained (CI working-directory depends on
  it); repo-flatten is a separate cleanup.
- **Windows/Linux support** deliberately out of scope for this push (macOS-only
  focus); Willow Voice, Talon, and Handy already ship Windows — tracked as a
  future multi-week platform investment, not attempted here.
- **Silero VAD v2**: the current hands-free gate is a cheap energy-threshold
  heuristic (accurate enough for a quiet room, weaker in noisy/multi-speaker
  environments); a proper VAD model is a deliberate v2, not done now.
- **SenseVoice as a first-class ASR route**: investigated, not done — it has
  no native `AsrProviderType` counterpart the existing MLX-route-mapping
  pattern requires, so doing it properly is a separate, larger provider
  addition, not a quick win.
- **Dictionary category-scope coupling**: category-scoped dictionary/snippet
  entries only take effect when the (differently-scoped) "AI formatting"
  toggle is on — a minor UX sharp edge worth decoupling in a follow-up.
- **Shortcut-conflict detection utility** (`partitionUniqueShortcutRegistrations`,
  ported alongside the hold-to-talk work) is tested but not yet wired into an
  actual conflict-detection UX — currently dormant, safe to activate later.
- **Packaged-build step currently broken, discovered 2026-07-06** (pre-existing,
  NOT caused by this push — confirmed via `git diff` that no `package.json`
  dependency changed across any of the 7 commits, only the `scripts` block
  gained `shortcut-helper:build` wiring): `bun run electron:pack` fails at the
  `electron-builder` native-packaging step with `production dependency not
  found: @radix-ui/react-dialog`, even though that package is genuinely
  present in `node_modules` and declared in `package.json`. Root cause is
  electron-builder's Bun-compatibility shim ("bun does not support any CLI for
  dependency tree extraction, utilizing file traversal collector instead") —
  its manual `node_modules` traversal fails to resolve this dependency, likely
  from an electron-builder or Radix version bump since the last verified
  packaged build (2026-06-13) that this repo's CI never re-checks (CI's
  "production build" step only runs `bun run build:renderer`, never the full
  `electron-builder` packaging path — so this regression had no gate to catch
  it). All of this session's actual code changes are independently verified
  via typecheck/vitest/cargo-test/clippy/knip/ipc-contract, which do NOT
  exercise this packaging step — the feature work itself is not implicated.
  Needs investigation (electron-builder version pin, or its Bun-collector
  config) separately from this push.

## Done since the first checklist

- ✅ **`oss-relaunch` branch pushed** to `github.com/JonathanRReed/Plainsong`.
- ✅ **GitHub repo renamed** `NautilusBot → Plainsong`; local remote updated, so
  the publish/auto-update URLs now resolve.
- ✅ **Site domain live**: https://plainsong.jonathanrreed.com is registered as a
  subdomain of the maker's domain and wired into the docs/config. (The optional
  `plainsong.app` apex + `@plainsong` social handles are separate and only if
  still wanted.)

## Remaining — physically require a human (no AI can do these)

- **One on-device validation run**: launch the app on a Mac, grant Microphone +
  Accessibility, **speak into the mic**, confirm dictation inserts into real
  apps, watch the first-run `base.en` download, feel the streaming. (Needs voice
  + GUI permission grants — cannot be automated.)
- **(Optional) Register `plainsong.app` apex + grab `@plainsong` handles** (needs
  payment/accounts). Not a blocker: the live site already runs at
  https://plainsong.jonathanrreed.com.
- **Attorney USPTO TSDR clearance** (Classes 9 + 42) — confirmation, not
  investigation; the name vetted clean in-category. (Needs a lawyer.)
- **$99 Apple Developer ID** → signed + notarized releases (the pipeline already
  uses the secrets when present).
