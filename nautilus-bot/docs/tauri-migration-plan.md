# Plan: migrate the shell from Electron to Tauri v2

**Status:** planned, not started. No Tauri code exists in this repo. This is the
highest-leverage *architectural* bet, but it is a multi-session rewrite of the
app shell that leaves the app unrunnable if half-landed, so it must be done on a
branch with the app running at each step — not blind.

**What has changed since this plan was first written:** the premise it rested on
— that `dispatch_command` is a callable seam rather than something buried in a
38k-line file — is now true. `rust-sidecar/src/lib.rs` was 37,881 lines with the
router in the middle of it; it is 4,626 lines, and the router is
`rust-sidecar/src/dispatch.rs`. Nothing was renamed or re-signed to get there.

## Why

Three independent findings traced bugs to the Electron↔sidecar process boundary
(serial dispatch was the worst; fixed now, but the boundary remains). Research:
every credible competitor in this niche is Tauri/Rust (Handy, Whispering,
OpenLess) or native Swift (VoiceInk). Tauri promotes our Rust sidecar from
"subprocess behind a JSON-RPC bridge" to the **in-process app core**, deleting
the bridge and the serial-loop class of problem entirely.

### The measured case, on this machine

Every number below is from a receipt in `artifacts/qa/`, taken on an Apple M4
Pro (14 cores, 24 GB, macOS 27.0). **The machine was never quiet.** The
1-minute load average was sampled for four hours and ranged 9.3–279; the
condition of "load below ~6" was never met. Each figure carries the load it was
taken at, and timing figures are pessimistic readings, not optimistic ones.

| what | measured | source |
|---|---|---|
| Installed app | **383.92 MB** at `a84d2abb`, **297.22 MB** after the locale trim | `receipts-2026-09-02.md`, `shell-size-receipt-2026-09-02.md` |
| `Electron Framework` binary alone | **182 MB — 61% of the installed app**, and untouchable | shell-size receipt |
| Everything Plainsong ships | 39.02 MB sidecar + 4.08 MB `app.asar` + 2.49 MB CLI | shell-size receipt |
| DMG | 132.49 MB (UDZO) → 129.22 MB (ULFO, taken); 97.96 MB with lzma, which electron-builder rejects | shell-size receipt |
| Cold start | **728 ms** to "App rendered", 2,500 ms threshold, at load 10.16 | `receipts-2026-09-02.md` |
| Idle sidecar RSS | **26.0 MiB**, flat over 10 samples, at load 13 | `receipts-2026-09-02.md` |
| Idle whole-app footprint | 172–187 MB **excluding** the GPU helper, which alone swings 144–237 MB run to run *within the same bundle* | shell-size receipt |
| Idle CPU | 0.07% average with call detection on, 0.10% off — below the noise floor at load 12–14 | `receipts-2026-09-02.md` |

Read that table as the case for the migration and as the limit of what can be
claimed today:

- **The size case is solid and needs no re-run.** A byte count over a directory
  tree does not care about load. 182 MB of Chromium is 61% of what users
  install, for a UI surface of one window and two small overlays.
- **The memory case is not yet made.** The receipts explicitly refuse to quote
  an idle-memory figure: on a swapping machine RSS reports what the kernel is
  letting a process keep. The `docs/competitive-positioning.md` claim of "1.9 MB
  idle RSS on the sidecar" is **not reproducible** — the sidecar measures
  10–26 MB — and must not be repeated. A quiet-machine re-run of startup and
  idle memory is owed before/after any Tauri prototype, or the comparison will
  be worthless.
- **Cold start already passes with 3.4× headroom.** Tauri is unlikely to be the
  win here, and claiming otherwise without a measurement would be dishonest.

## What transfers unchanged (most of the value is already banked)

The entire `rust-sidecar/` crate — audio capture, ASR engines, dictation
pipeline, diarization, LLM clients, storage, text insertion — is plain Rust with
no Electron dependency. The React renderer in `src/` is framework-agnostic: it
talks to a small `window.electronAPI` shim in `src/lib/electron.ts` that is
already described in-code as a "Tauri-compatibility shim".

### The module map a Tauri command layer would call into

`lib.rs` is now the crate root, the shared types, and the sidecar lifecycle. The
handlers live in modules a `#[tauri::command]` can call directly:

| module | lines | what a Tauri host would use it for |
|---|---:|---|
| `dispatch` | 4,081 | **the seam.** `dispatch_command` and its 193 arms |
| `dictation_session` | 2,976 | start/stop a dictation session; the hot path |
| `text_insert` | 2,163 | AX + clipboard + keystroke insertion, unchanged under Tauri |
| `recording_lifecycle` | 1,968 | meeting start/pause/stop and the capture monitors |
| `recording_vault` | 1,933 | encryption at rest, vault keys, playback staging |
| `dictation_text` | 1,798 | transcript sanitising, rewrites, prompt resolution |
| `analysis` | 1,463 | the meeting analysis passes and grounded output |
| `meeting_transcribe` | 1,265 | chunked transcription, diarizer choice |
| `retention` | 1,210 | retention policies and meeting auto-naming |
| `dictation_reprocess` | 1,105 | reprocessing, selected-text transforms |
| `settings_values` | 792 | settings-string normalisation, model warm-up |
| `meeting_pipeline` | 716 | the post-stop pipeline |
| `audio_import_runtime` | 691 | `import_audio_file` |
| `speakers` | 676 | speaker aliases and voice clusters |
| `asr_routing` | 676 | provider/model selection and fallback |
| `permissions` | 675 | **rewrite candidate.** TCC prompts and Setup diagnostics |
| `dictation_live_preview` | 657 | live-preview engine and task |
| `streaming_partials` | 460 | partial-decode scheduling, VAD cut points |
| `dictation_commands` | 391 | spoken-command capture and execution |
| `model_cache` | 357 | model artifact validation and repair |
| `export_paths` | 323 | approved roots and the path guard |
| `provider_models` | 179 | remote provider catalogues |
| `tests` | 7,284 | the handler tests |

Only `permissions` and the overlay/hotkey surfaces are shell-coupled. Everything
else is host-agnostic Rust today.

## The seam, precisely

```
src/bin/sidecar.rs          reads one newline-delimited JSON-RPC request
  → plainsong::dispatch_command(&state, &handle, method, params)
      → src/dispatch.rs     match method { … 193 arms … }
```

A Tauri host replaces only the first line. `dispatch_command` takes
`(&Arc<AppState>, &SidecarHandle, &str, serde_json::Value)` and returns
`Result<serde_json::Value, String>`; none of that is Electron-shaped. The two
realistic shapes for the Tauri side are:

1. **One generic command.** `#[tauri::command] async fn sidecar(method: String,
   params: Value)` forwards straight to `dispatch_command`. The renderer shim
   changes in one place, the allowlist stays the security boundary, and nothing
   in the sidecar moves. Fastest to a running prototype.
2. **One `#[tauri::command]` per method.** Type-safe at the boundary and
   introspectable from the renderer, but it needs the 193 arms lifted into named
   handler functions first (see "Prerequisite" below), and it moves the
   allowlist's job into Tauri's capability system.

Start with (1) behind a feature flag; (2) is a later refinement, not a
precondition.

### Prerequisite the split did not do

`dispatch_command` is still a `match` of **inline handler bodies**, not a thin
router. Lifting ~193 arms into named handler functions is a logic edit, so it
was deliberately excluded from the move-only split that created `dispatch.rs`.
Shape (1) above does not need it. Shape (2) does. Either way it is now a change
inside one 4k-line file rather than a conflict with every other lane touching
the sidecar.

## The command manifest already exists

There is no need to enumerate the app's surface by hand: the IPC allowlist *is*
the manifest, and `scripts/verify-ipc-contract.mjs` keeps it honest in both
directions. Its current output:

```
IPC contract validation passed: 207 renderer commands checked, 28 Electron
local commands derived from main.ts, 195 sidecar commands discovered, 193
dispatched commands all reachable.
```

- `ALLOWED_RENDERER_COMMANDS` in `electron/ipc-bridge.ts` — 207 entries — is the
  complete set of things the renderer may ask for. Under Tauri it becomes the
  same allowlist in the Rust host, or Tauri capabilities scoped to the generic
  command.
- 28 of those are answered by `handleLocalCommand` in `electron/main.ts` —
  windows, tray, dialogs, updater. **These are the migration's real work**, and
  the count is the size of the shell surface: 28 things, not 207.
- 193 are `dispatch_command` arms in `dispatch.rs` and port for free.
- The gate's `intentionallyUnreachableSidecarCommands` list names the RPCs the
  renderer may *not* call (privileged approvals, support-bundle writes,
  `import_audio_file`, the CLI/headless entry points). Those constraints must
  survive the move; they are security decisions, not accidents.

Two Rust tests (`the_ipc_contract_gate_can_still_read_the_dispatcher`,
`no_command_is_dispatched_twice`) pin the anchors the gate slices on, so a
refactor that moves the router fails in `cargo test` rather than making the gate
throw.

## What changes

1. **Host process.** Replace `electron/main.ts` with a Tauri v2 Rust binary
   (`src-tauri/`) that owns windows, the global hotkey, and the tray. The 28
   local commands are what has to be rewritten.
2. **IPC.** Replace the stdio JSON-RPC bridge (`electron/ipc-bridge.ts`,
   `bin/sidecar.rs`) with Tauri `invoke`. `src/lib/electron.ts` becomes a thin
   wrapper over `invoke`/`listen`. Events (`SidecarHandle.emit_event`) map to
   Tauri's event system.
3. **Overlays.** The two frameless, focus-preserving overlays
   (`electron/windows.ts`, `focusable: false` + `alwaysOnTop` + `showInactive()`)
   are **the riskiest part**. Plain Tauri `WebviewWindow` does not reproduce a
   non-activating panel on macOS; use **`tauri-nspanel`**, which converts a
   window to an `NSPanel` with `NSWindowStyleMaskNonactivatingPanel` — the same
   AppKit mechanism Electron's `focusable: false` uses underneath. Overlay
   placement logic (`electron/overlay-placement.ts`) is pure TypeScript and
   ports as data.
4. **Global hotkey.** Keep `scripts/native-macos-shortcut-helper.swift` as-is.
   It is already a standalone CGEventTap process that reads a JSON binding table
   on argv and prints `{"event":"down"|"up","bindingId":…}` lines on stdout —
   which is precisely why hold-to-talk works at all, since Electron's
   `globalShortcut` reports presses only. It has no Electron dependency and does
   not need porting; the Tauri host spawns it exactly as `electron/
   native-macos-shortcut-runtime.ts` does. **Do not** substitute Tauri's
   global-shortcut plugin: it has the same press-only limitation.
5. **Insertion.** Unchanged. `rust-sidecar/src/text_insert.rs` already posts
   CGEvents and drives the AX API directly. On macOS, `workspace_frontmost_
   application` can drop its `osascript`/`lsappinfo` spawns for `objc2-app-kit`
   `NSWorkspace` once there is an AppKit host — a latency win in the hot path,
   and independently testable.
6. **Updater + packaging.** Swap electron-builder/electron-updater for Tauri's
   bundler + updater plugin (static `latest.json` + signed artifacts on GitHub
   Releases). Note what this must preserve: `scripts/verify-macos-release-trust.
   mjs`, `scripts/verify-packaged-native-helpers.mjs` (entitlements on every
   helper), `scripts/generate-third-party-notices.mjs`, and the
   `gate:packaged:macos:native` / `gate:size` / `gate:cold-start` gates. The
   release workflow is a rewrite, not a swap.
7. **Sidecar binary.** `bin/sidecar.rs` and the stdio protocol go away, or stay
   as a headless test harness — which is worth keeping, since a large part of
   the test suite and `benchmark-latency` drive the sidecar that way.

## Sequencing, with exit criteria

Each step keeps the app runnable and shippable on Electron. Do not start the
next step until the previous one's exit criterion is met and written down.

**0. Baseline, on a quiet machine.**
Re-take cold start, idle memory (whole tree, `phys_footprint` not RSS), and
`gate:size` against the current Electron build with 1-minute load below ~6.
*Exit:* a receipt in `artifacts/qa/` with load stated per run. Without this
there is nothing to compare a Tauri prototype to, and the existing receipts say
so in their own words.

**1. Scaffold `src-tauri/` alongside Electron.**
An empty Tauri window loading the existing Vite build. Electron untouched.
*Exit:* `bun run dev` still starts Electron; a separate command starts Tauri and
renders the app shell; both build in CI.

**2. `invoke` for read-only commands.**
Wire the generic `sidecar(method, params)` command and route a handful of
read-only methods (`get_settings`, `get_recordings`, `get_permission_
diagnostics`) through it behind a renderer feature flag.
*Exit:* the Settings and Library screens render under Tauri with real data;
`gate:ipc-contract` passes unchanged; no write path is reachable yet.

**3. The dictation hot path.**
Hotkey (spawn the existing Swift helper) → start/stop → insertion → the
dictation overlay via `tauri-nspanel`.
*Exit:* the overlay does not steal focus from the target app across spaces and
fullscreen, measured by dictating into three apps including one fullscreen;
`bun run benchmark:latency` on `scripts/fixtures/real-speech-44s.wav` within
noise of the Electron numbers **on a quiet machine**; hold-to-talk releases
correctly.

**4. Meetings, tray, updater, launch-at-login.**
The remaining 28 local commands. The recording overlay follows the dictation
overlay's panel pattern.
*Exit:* a full meeting recorded, transcribed, analysed and exported under Tauri;
tray and launch-at-login behave; a signed Tauri artifact updates itself from a
`latest.json` on a test channel.

**5. Delete the Electron shell.**
Remove `electron/`, the stdio bridge, electron-builder, and the electron-updater
dependency closure. Rewrite the release workflow and the packaging gates.
*Exit:* `gate:size` and `gate:cold-start` pass against the Tauri bundle;
`gate:release:licenses` regenerates notices from the new dependency set;
step 0's measurements are re-taken and the size delta is recorded as a receipt.

## Risks to watch

- **Overlay focus/click-through parity** across macOS spaces and fullscreen.
  `tauri-nspanel` is a community plugin, not first-party; its version pin and
  maintenance state are a real dependency risk and belong in the step-3
  evaluation, not in step 5.
- **WebView differences.** Tauri uses WKWebView/WebView2/WebKitGTK, not bundled
  Chromium. The UI surface is small, but the popup and settings need testing,
  and the renderer's CSS baseline assumptions change.
- **Keychain and TCC identity.** Permissions and `secrets.rs` are keyed to the
  app's bundle identity. A new bundle re-prompts for microphone, accessibility
  and screen recording, and may not find existing keychain items. Plan the
  upgrade path before step 5, not after.
- **Linux is Tauri's roughest edge** (Wayland hotkeys, `wtype`/`dotool`
  insertion); ship macOS first, Windows second, Linux last.

## Recommendation

The size argument is measured and holds: 182 MB of Chromium for one window and
two overlays. The memory and startup arguments are **not yet measured honestly**
and should not be used to justify the work until step 0 exists. Treat Tauri as a
deliberate, staged branch, not a big-bang rewrite — and note that the single
largest blocker, a router that could not be called without dragging 38k lines
with it, is no longer one.
