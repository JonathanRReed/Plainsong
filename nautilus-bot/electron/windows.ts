import { BrowserWindow } from "electron";
import path from "path";

// Initial bounds are placeholders — the windows are created hidden (show: false)
// and showOverlayWindow() repositions them onto the active display (the one under
// the cursor, inside its notch-safe work area) before they are ever shown.
export function createDictationOverlayWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 420,
    height: 120,
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
    width: 320,
    height: 80,
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
