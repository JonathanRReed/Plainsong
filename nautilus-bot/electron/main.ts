import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync } from "fs";
import path from "path";
import { autoUpdater, type AppUpdater } from "electron-updater";
import {
  resolveDictationShortcutBehavior,
  resolveDictationShortcutDecision,
} from "./dictation-shortcut-controller";
import { IpcBridge } from "./ipc-bridge";
import { createDictationOverlayWindow, createRecordingOverlayWindow } from "./windows";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const devServerUrl = process.env.NAUTILUS_DEV_SERVER_URL ?? "http://127.0.0.1:1420";
const rendererMode = process.env.NAUTILUS_RENDERER_MODE ?? "file";

if (isDev) {
  app.commandLine.appendSwitch("no-proxy-server");
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>;localhost;127.0.0.1");
}

let mainWindow: BrowserWindow | null = null;
let ipcBridge: IpcBridge | null = null;
let dictationPhase = "idle";
let updaterConfigured = false;
let updateReadyToInstall = false;
let bootstrapComplete = false;

function qaLog(message: string, payload?: unknown): void {
  if (process.env.NAUTILUS_QA_PACKAGED_HOTKEY === "1") {
    console.log(`[qa] ${message}`, payload ?? "");
  }
}

type UpdateChannel = "stable" | "beta";
type UpdateInfoPayload = {
  version: string;
  notes: string;
  pubDate: string;
  isBeta: boolean;
};
type UpdateStatusPayload = {
  status:
    | "unknown"
    | "checking"
    | "upToDate"
    | "updateAvailable"
    | "downloading"
    | "installing"
    | "error";
  info?: UpdateInfoPayload;
  progress?: number;
  error?: string;
};

let updateStatus: UpdateStatusPayload = { status: "unknown" };

type AppSettings = {
  shortcuts?: {
    toggleDictation?: string;
    openWindow?: string;
  };
  transcription?: {
    dictationPushToTalk?: boolean;
    dictationHandsFreeEnabled?: boolean;
  };
};

function getWindowLabel(win: BrowserWindow | null): string | null {
  if (!win) {
    return null;
  }
  if (win === mainWindow) {
    return "main";
  }
  return (win as BrowserWindow & { _label?: string })._label ?? null;
}

function findWindowByLabel(label: string): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find((win) => getWindowLabel(win) === label) ?? null
  );
}

function showAndFocusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function broadcastRendererEvent(eventName: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(`sidecar:event:${eventName}`, payload);
    }
  }
}

function normalizeReleaseNotes(notes: unknown): string {
  if (typeof notes === "string") {
    return notes.trim();
  }

  if (Array.isArray(notes)) {
    return notes
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const version =
          "version" in entry && typeof entry.version === "string" ? entry.version : null;
        const note =
          "note" in entry && typeof entry.note === "string"
            ? entry.note
            : "note" in entry && typeof entry.note === "number"
              ? String(entry.note)
              : "";
        return version ? `${version}\n${note}`.trim() : note.trim();
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return "";
}

function normalizeUpdateInfo(info: unknown): UpdateInfoPayload | undefined {
  if (!info || typeof info !== "object") {
    return undefined;
  }

  const record = info as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version : null;
  if (!version) {
    return undefined;
  }

  const notes = normalizeReleaseNotes(record.releaseNotes);
  const pubDate =
    typeof record.releaseDate === "string"
      ? record.releaseDate
      : typeof record.pubDate === "string"
        ? record.pubDate
        : "";
  const loweredVersion = version.toLowerCase();

  return {
    version,
    notes,
    pubDate,
    isBeta: loweredVersion.includes("beta") || loweredVersion.includes("alpha"),
  };
}

function setUpdateStatus(next: UpdateStatusPayload): void {
  updateStatus = next;
  broadcastRendererEvent("update-status-changed", next);
}

async function getUpdateChannelFromSidecar(): Promise<UpdateChannel> {
  if (!ipcBridge) {
    return "stable";
  }

  try {
    const result = await ipcBridge.invokeSidecar("get_update_channel");
    return result === "beta" ? "beta" : "stable";
  } catch (error) {
    console.error("[updater] failed to read update channel, defaulting to stable", error);
    return "stable";
  }
}

function configureAutoUpdater(updater: AppUpdater): void {
  if (updaterConfigured) {
    return;
  }

  try {
    updaterConfigured = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;

    updater.on("checking-for-update", () => {
      updateReadyToInstall = false;
      setUpdateStatus({ status: "checking" });
    });

    updater.on("update-available", (info) => {
      updateReadyToInstall = false;
      setUpdateStatus({
        status: "updateAvailable",
        info: normalizeUpdateInfo(info),
      });
    });

    updater.on("update-not-available", () => {
      updateReadyToInstall = false;
      setUpdateStatus({ status: "upToDate" });
    });

    updater.on("download-progress", (progress) => {
      setUpdateStatus({
        status: "downloading",
        info: updateStatus.info,
        progress: typeof progress.percent === "number" ? progress.percent : undefined,
      });
    });

    updater.on("update-downloaded", (info) => {
      updateReadyToInstall = true;
      setUpdateStatus({
        status: "updateAvailable",
        info: normalizeUpdateInfo(info),
        progress: 100,
      });
    });

    updater.on("error", (error) => {
      updateReadyToInstall = false;
      setUpdateStatus({
        status: "error",
        info: updateStatus.info,
        error: error.message,
      });
    });
  } catch (error) {
    console.error("[updater] failed to configure autoUpdater:", error);
    setUpdateStatus({
      status: "error",
      error: error instanceof Error ? error.message : "Failed to configure updater",
    });
  }
}

async function checkForUpdatesInElectron(): Promise<UpdateInfoPayload | null> {
  if (!app.isPackaged) {
    const error = "Updates are only available in packaged builds.";
    setUpdateStatus({ status: "error", error });
    throw new Error(error);
  }

  const channel = await getUpdateChannelFromSidecar();
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = channel === "beta";
  autoUpdater.allowDowngrade = channel === "beta";

  const result = await autoUpdater.checkForUpdates();
  const info = normalizeUpdateInfo(result?.updateInfo);
  return info ?? null;
}

async function installUpdateInElectron(): Promise<void> {
  if (!app.isPackaged) {
    throw new Error("Updates are only available in packaged builds.");
  }

  if (!updateStatus.info) {
    throw new Error("No downloaded or available update is ready to install.");
  }

  if (!updateReadyToInstall) {
    setUpdateStatus({
      status: "downloading",
      info: updateStatus.info,
      progress: updateStatus.progress,
    });
    await autoUpdater.downloadUpdate();
  }

  setUpdateStatus({
    status: "installing",
    info: updateStatus.info,
  });
  autoUpdater.quitAndInstall();
}

function showOverlayWindow(win: BrowserWindow): void {
  if (process.platform === "darwin") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  win.setAlwaysOnTop(true, "screen-saver");
  win.showInactive();
}

function ensureDictationOverlayWindow(): { window: BrowserWindow; needsLoad: boolean } {
  const existing = findWindowByLabel("dictation-overlay");
  if (existing) {
    configureWindowSecurity(existing);
    showOverlayWindow(existing);
    return { window: existing, needsLoad: false };
  }

  const overlay = createDictationOverlayWindow();
  (overlay as BrowserWindow & { _label?: string })._label = "dictation-overlay";
  configureWindowSecurity(overlay);
  return { window: overlay, needsLoad: true };
}

function ensureRecordingOverlayWindow(): { window: BrowserWindow; needsLoad: boolean } {
  const existing = findWindowByLabel("recording-overlay");
  if (existing) {
    configureWindowSecurity(existing);
    showOverlayWindow(existing);
    return { window: existing, needsLoad: false };
  }

  const overlay = createRecordingOverlayWindow();
  (overlay as BrowserWindow & { _label?: string })._label = "recording-overlay";
  configureWindowSecurity(overlay);
  return { window: overlay, needsLoad: true };
}

async function handleLocalCommand(
  event: IpcMainInvokeEvent,
  command: string,
  args: unknown
): Promise<{ handled: boolean; result?: unknown }> {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  switch (command) {
    case "__window_set_size__": {
      if (!senderWindow) {
        return { handled: true, result: null };
      }
      const payload = (args ?? {}) as { width?: unknown; height?: unknown };
      if (typeof payload.width === "number" && typeof payload.height === "number") {
        senderWindow.setSize(Math.round(payload.width), Math.round(payload.height), true);
      }
      return { handled: true, result: null };
    }
    case "__window_set_position__": {
      if (!senderWindow) {
        return { handled: true, result: null };
      }
      const payload = (args ?? {}) as { x?: unknown; y?: unknown };
      if (typeof payload.x === "number" && typeof payload.y === "number") {
        senderWindow.setPosition(Math.round(payload.x), Math.round(payload.y), true);
      }
      return { handled: true, result: null };
    }
    case "__window_hide__":
      senderWindow?.hide();
      return { handled: true, result: null };
    case "__window_show__":
      senderWindow?.showInactive();
      return { handled: true, result: null };
    case "__window_start_drag__":
      // Dragging is handled through CSS app-region on Electron.
      return { handled: true, result: null };
    case "check_for_updates":
      return { handled: true, result: await checkForUpdatesInElectron() };
    case "install_update":
      await installUpdateInElectron();
      return { handled: true, result: null };
    case "get_update_status":
      return { handled: true, result: updateStatus };
    default:
      return { handled: false };
  }
}

function convertShortcutToAccelerator(shortcut: string | undefined): string | null {
  const value = shortcut?.trim();
  if (!value) {
    return null;
  }

  const tokens = value
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return null;
  }

  // Validate that the shortcut is not excessively long (security concern)
  if (tokens.length > 5) {
    console.error("[shortcuts] shortcut too long, rejecting:", value);
    return null;
  }

  const mapped = tokens.map((token) => {
    switch (token.toLowerCase()) {
      case "cmd":
      case "command":
        return "Command";
      case "ctrl":
      case "control":
        return "Control";
      case "alt":
      case "option":
        return "Alt";
      case "shift":
        return "Shift";
      case "space":
        return "Space";
      case "esc":
        return "Escape";
      case "enter":
      case "return":
        return "Enter";
      case "up":
        return "Up";
      case "down":
        return "Down";
      case "left":
        return "Left";
      case "right":
        return "Right";
      default:
        // Only allow single-character keys (letters, numbers, symbols)
        if (token.length === 1) {
          const char = token.toUpperCase();
          // Validate it's a printable ASCII character
          if (char >= '!' && char <= '~') {
            return char;
          }
        }
        console.error("[shortcuts] invalid token in shortcut:", token);
        return null;
    }
  });

  // If any token failed validation, reject the entire shortcut
  if (mapped.includes(null)) {
    return null;
  }

  return mapped.join("+");
}

async function handleDictationGlobalShortcut(settings: AppSettings): Promise<void> {
  if (!ipcBridge) {
    return;
  }

  const behavior = resolveDictationShortcutBehavior(settings.transcription ?? {});
  const decision = resolveDictationShortcutDecision({
    phase: dictationPhase as
      | "idle"
      | "recording"
      | "stopping"
      | "transcribing"
      | "delivering"
      | "done"
      | "error",
    behavior,
    capability: "press_only",
    signal: "pressed",
  });

  if (decision.action === "start") {
    qaLog("dictation shortcut start_dictation", { phase: dictationPhase, behavior });
    await ipcBridge.invoke("start_dictation", {});
    return;
  }

  if (decision.action === "stop") {
    qaLog("dictation shortcut stop_dictation", {
      phase: dictationPhase,
      behavior,
      stopReason: decision.stopReason ?? "toggle",
    });
    await ipcBridge.invoke("stop_dictation", {
      stopReason: decision.stopReason ?? "toggle",
    });
  }
}

async function applyElectronGlobalShortcuts(reason: string): Promise<void> {
  if (!ipcBridge) {
    return;
  }

  let settings: AppSettings;
  try {
    settings = (await ipcBridge.invoke("get_settings")) as AppSettings;
  } catch (error) {
    console.error("[shortcuts] failed to load settings", { reason, error });
    return;
  }

  const dictationShortcut = convertShortcutToAccelerator(settings.shortcuts?.toggleDictation);
  const openWindowShortcut = convertShortcutToAccelerator(settings.shortcuts?.openWindow);
  const behavior = resolveDictationShortcutBehavior(settings.transcription ?? {});
  const usesPressOnlyElectronFallback = behavior === "hold_to_talk";

  globalShortcut.unregisterAll();

  if (dictationShortcut) {
    const registered = globalShortcut.register(dictationShortcut, () => {
      void handleDictationGlobalShortcut(settings).catch((error) => {
        console.error("[shortcuts] dictation shortcut failed", error);
      });
    });

    if (!registered) {
      console.error("[shortcuts] failed to register dictation shortcut", {
        reason,
        dictationShortcut,
      });
    } else {
      console.log("[shortcuts] registered dictation shortcut", {
        reason,
        dictationShortcut,
        usesPressOnlyElectronFallback,
      });
    }
  }

  if (openWindowShortcut) {
    const registered = globalShortcut.register(openWindowShortcut, () => {
      showAndFocusMainWindow();
    });

    if (!registered) {
      console.error("[shortcuts] failed to register open window shortcut", {
        reason,
        openWindowShortcut,
      });
    }
  }
}

function getSidecarBinaryName(): string {
  return process.platform === "win32" ? "nautilus-sidecar.exe" : "nautilus-sidecar";
}

function getSidecarPath(): string {
  const binaryName = getSidecarBinaryName();

  if (isDev) {
    const debugPath = path.join(__dirname, "../rust-sidecar/target/debug", binaryName);
    if (existsSync(debugPath)) {
      return debugPath;
    }

    return path.join(__dirname, "../rust-sidecar/target/release", binaryName);
  }

  return path.join(process.resourcesPath, "sidecar", binaryName);
}

function isRendererAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);

    if (url.protocol === "file:") {
      return true;
    }

    if (isDev && rendererMode === "server") {
      return url.origin === new URL(devServerUrl).origin;
    }

    return false;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function configureWindowSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isRendererAppUrl(url)) {
      return;
    }

    event.preventDefault();

    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  configureWindowSecurity(win);

  win.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    win.webContents.on("did-start-loading", () => {
      console.log("[renderer] did-start-loading", win.webContents.getURL());
    });
    win.webContents.on("did-finish-load", () => {
      console.log("[renderer] did-finish-load", win.webContents.getURL());
      win.webContents.openDevTools();
      setTimeout(() => {
        void win.webContents
          .executeJavaScript(`({
            bodyText: document.body.innerText.slice(0, 400),
            bodyHtml: document.body.innerHTML.slice(0, 400),
            headHtml: document.head.innerHTML.slice(0, 400),
            hasElectronApi: typeof window.electronAPI !== "undefined",
            readyState: document.readyState,
            resourceUrls: performance
              .getEntriesByType("resource")
              .map((entry) => entry.name)
              .slice(0, 20),
          })`)
          .then((snapshot) => {
            console.log("[renderer] snapshot", snapshot);
          })
          .catch((error) => {
            console.error("[renderer] snapshot failed", error);
          });
      }, 1500);
    });
    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
      console.error("[renderer] did-fail-load", {
        errorCode,
        errorDescription,
        validatedUrl,
      });
    });
    win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log("[renderer:console]", { level, message, line, sourceId });
    });
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer] render-process-gone", details);
    });
    if (rendererMode === "server") {
      void win.loadURL(devServerUrl);
    } else {
      void win.loadFile(path.join(__dirname, "../dist/index.html"));
    }
  } else {
    void win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  return win;
}

process.on("uncaughtException", (error) => {
  console.error("[main] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandled rejection", reason);
});

app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  ipcBridge?.shutdown();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!bootstrapComplete) {
    // Bootstrap hasn't completed yet, wait for it to finish
    return;
  }
  if (mainWindow === null || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  } else if (!mainWindow.isVisible()) {
    mainWindow.show();
  } else if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
});

ipcMain.handle("window:get-label", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return null;
  }
  return getWindowLabel(win);
});


async function bootstrap() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    showAndFocusMainWindow();
  });

  await app.whenReady();

  if (isDev && rendererMode === "server") {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timed out")), 5000);
    });

    try {
      const response = await Promise.race([net.fetch(devServerUrl), timeout]);
      const body = await response.text();
      console.log("[dev] net.fetch ok", {
        status: response.status,
        url: devServerUrl,
        bodyPreview: body.slice(0, 80),
      });
    } catch (error) {
      console.error("[dev] net.fetch failed", { url: devServerUrl, error });
    }
  }

  const sidecarPath = getSidecarPath();

  if (!existsSync(sidecarPath)) {
    const message =
      `The NautilusBot sidecar binary was not found at:\n${sidecarPath}\n\n` +
      "Build it from source with:\n  bun run sidecar:build:release";
    console.error("[sidecar] missing binary", { sidecarPath });
    dialog.showErrorBox("NautilusBot sidecar not found", message);
    broadcastRendererEvent("sidecar-error", { reason: "missing-binary", path: sidecarPath, message });
  }

  ipcBridge = new IpcBridge(sidecarPath);
  ipcBridge.onLocalCommand(handleLocalCommand);
  configureAutoUpdater(autoUpdater);

  ipcBridge.onEvent((eventName: string, payload: unknown) => {
    if (
      eventName === "dictation-state-changed" &&
      payload &&
      typeof payload === "object" &&
      "phase" in payload &&
      typeof (payload as { phase?: unknown }).phase === "string"
    ) {
      dictationPhase = (payload as { phase: string }).phase;
    }

    broadcastRendererEvent(eventName, payload);
  });

  ipcBridge.onWindowCommand((command: string, payload: unknown) => {
    if (command === "show-dictation-overlay") {
      const { window: overlay, needsLoad } = ensureDictationOverlayWindow();
      if (needsLoad) {
        overlay.webContents.once("did-finish-load", () => showOverlayWindow(overlay));
        if (isDev && rendererMode === "server") {
          void overlay.loadURL(`${devServerUrl}?overlay=dictation`);
        } else {
          void overlay.loadFile(path.join(__dirname, "../dist/index.html"), {
            query: { overlay: "dictation" },
          });
        }
      }
    } else if (command === "show-recording-overlay") {
      const { window: overlay, needsLoad } = ensureRecordingOverlayWindow();
      if (needsLoad) {
        overlay.webContents.once("did-finish-load", () => showOverlayWindow(overlay));
        if (isDev && rendererMode === "server") {
          void overlay.loadURL(`${devServerUrl}?overlay=recording`);
        } else {
          void overlay.loadFile(path.join(__dirname, "../dist/index.html"), {
            query: { overlay: "recording" },
          });
        }
      }
    } else if (command === "open-main") {
      showAndFocusMainWindow();
    } else if (command === "open-main-to") {
      showAndFocusMainWindow();
      broadcastRendererEvent("main-view-requested", payload ?? {});
    } else if (command === "hide-dictation-overlay") {
      BrowserWindow.getAllWindows()
        .filter((w) => (w as BrowserWindow & { _label?: string })._label === "dictation-overlay")
        .forEach((w) => w.hide());
    } else if (command === "hide-recording-overlay") {
      BrowserWindow.getAllWindows()
        .filter((w) => (w as BrowserWindow & { _label?: string })._label === "recording-overlay")
        .forEach((w) => w.hide());
    }
  });

  ipcBridge.onCommandResolved((command) => {
    if (command === "save_settings" || command === "apply_global_shortcuts_now") {
      void applyElectronGlobalShortcuts(command);
    }
  });

  ipcBridge.start();
  await applyElectronGlobalShortcuts("startup");

  mainWindow = createMainWindow();
  bootstrapComplete = true;
}

void bootstrap();
