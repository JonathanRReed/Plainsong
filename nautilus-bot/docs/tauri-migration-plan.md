# Plan: migrate the shell from Electron to Tauri v2

**Status:** planned, not started. This is the highest-leverage *architectural*
bet, but it's a multi-session rewrite of the app shell that leaves the app
unrunnable if half-landed, so it must be done on a branch with the app running
at each step — not blind.

## Why

Three independent findings traced bugs to the Electron↔sidecar process boundary
(serial dispatch was the worst; fixed now, but the boundary remains). Research:
every credible competitor in this niche is Tauri/Rust (Handy, Whispering,
OpenLess) or native Swift (VoiceInk); Electron idles at ~200–450 MB vs Tauri's
~30–170 MB, and Wispr Flow's ~800 MB Electron build is the cautionary tale.
Tauri promotes our ~50k-LOC Rust sidecar from "subprocess behind a JSON-RPC
bridge" to the **in-process app core**, deleting the bridge and the serial-loop
class of problem entirely.

## What transfers unchanged (most of the value already banked)

The entire `rust-sidecar/` crate — audio capture, ASR engines, dictation
pipeline, diarization, LLM clients, storage, text insertion — is plain Rust with
no Electron dependency. All the latency and correctness work done this cycle
lives here and ports as-is. The React renderer in `src/` is framework-agnostic
(it talks to a small `window.electronAPI` shim in `src/lib/electron.ts` that is
already described in-code as a "Tauri-compatibility shim").

## What changes

1. **Host process.** Replace `electron/main.ts` with a Tauri v2 Rust binary
   (`src-tauri/`) that owns windows, the global hotkey, and the tray. The
   sidecar's `dispatch_command` becomes Tauri `#[tauri::command]` handlers (or a
   thin in-process command router) — the existing `dispatch_command` match can
   be reused almost verbatim, called directly instead of over stdio.
2. **IPC.** Replace the stdio JSON-RPC bridge (`electron/ipc-bridge.ts`,
   `bin/sidecar.rs`) with Tauri `invoke`. Keep the existing renderer command
   allowlist concept; `src/lib/electron.ts` becomes a thin wrapper over Tauri's
   `invoke`/`listen`. Events (`SidecarHandle.emit_event`) map to Tauri's event
   system.
3. **Windows/overlays.** Recreate the main window + the two frameless,
   focus-preserving overlays (`electron/windows.ts`) as Tauri `WebviewWindow`s
   with `focusable: false`, always-on-top, skip-taskbar. **This is the riskiest
   part** — overlay focus behavior and click-through differ per platform.
4. **Global hotkey + insertion.** Keep these as direct Rust FFI, not framework
   plugins: a CGEventTap-based key listener (also unlocks real hold-to-talk,
   which Electron's press-only `globalShortcut` can't do) and the existing
   AX/CGEvent insertion. On macOS use `objc2-app-kit` `NSWorkspace` for the
   frontmost-app capture (also removes the `osascript`/`lsappinfo` spawns from
   the hot path).
5. **Updater + packaging.** Swap electron-builder/electron-updater for Tauri's
   bundler + updater plugin (static `latest.json` + signed artifacts on GitHub
   Releases). Rework the release workflow accordingly.
6. **Sidecar binary.** `bin/sidecar.rs` and the stdio protocol go away (or stay
   temporarily as a headless test harness). The `benchmark-latency` bin stays.

## Sequencing (each step keeps the app runnable)

1. Scaffold `src-tauri/` alongside Electron; get an empty Tauri window loading
   the existing Vite build.
2. Port `invoke` for a handful of read-only commands (get_settings, etc.);
   prove the renderer works under Tauri with a feature flag.
3. Port the dictation hot path: hotkey → start/stop → insertion, with the
   overlays. Validate latency with `benchmark:latency` and real dictation.
4. Port meetings, updates, tray, launch-at-login.
5. Delete the Electron shell and the stdio bridge; update CI/release.

## Risks to watch

- Overlay focus/click-through parity across macOS spaces and fullscreen.
- WebView differences (Tauri uses WKWebView/WebView2/WebKitGTK, not bundled
  Chromium) — the UI surface is small, but test the popup and settings.
- Global hotkey reliability (use raw CGEventTap, not the global-shortcut plugin).
- Linux is Tauri's roughest edge (Wayland hotkeys + `wtype`/`dotool` insertion);
  ship macOS first, Windows second, Linux last.

## Recommendation

Do this *after* streaming partials land and stabilize on the current stack —
streaming validates the hot-path design, and that work ports into Tauri
unchanged. Treat Tauri as a deliberate, staged branch, not a big-bang rewrite.
