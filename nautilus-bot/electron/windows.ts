import { BrowserWindow } from "electron/main";
import path from "path";
import { OVERLAY_BASE_SIZE } from "./overlay-placement";

// Initial bounds are placeholders — the windows are created hidden (show: false)
// at bootstrap (see prepareOverlayWindows in main.ts, so the first hotkey press
// does not wait on a React cold boot) and showOverlayWindow() bottom-anchors them
// on the active display (the one under the cursor, inside its notch-safe work
// area) before they are ever shown.
//
// `focusable: false` plus showInactive() everywhere is what keeps these
// non-activating: the caret must keep blinking in the user's target field for
// the whole session, and any focus flicker reads as a wrapper app.
export function createDictationOverlayWindow(): BrowserWindow {
  return new BrowserWindow({
    width: OVERLAY_BASE_SIZE.dictation.width,
    height: OVERLAY_BASE_SIZE.dictation.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

export function createRecordingOverlayWindow(): BrowserWindow {
  return new BrowserWindow({
    width: OVERLAY_BASE_SIZE.recording.width,
    height: OVERLAY_BASE_SIZE.recording.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}
