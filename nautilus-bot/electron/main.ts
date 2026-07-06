import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  screen,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { existsSync } from "fs";
import path from "path";
import { autoUpdater, type AppUpdater } from "electron-updater";
import {
  resolveDictationShortcutBehavior,
  resolveDictationShortcutCapability,
  resolveDictationShortcutDecision,
  shouldHandleDictationShortcutSource,
} from "./dictation-shortcut-controller";
import { IpcBridge } from "./ipc-bridge";
import {
  normalizeNativeShortcutEvent,
  type NativeShortcutController,
  type NativeShortcutRawEvent,
} from "./native-macos-shortcut";
import { startNativeMacosShortcutController } from "./native-macos-shortcut-runtime";
import {
  convertShortcutToAccelerator,
  findConflictingShortcuts,
  type ShortcutConflictInfo,
} from "./shortcut-registration";
import { createDictationOverlayWindow, createRecordingOverlayWindow } from "./windows";

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
const devServerUrl = process.env.PLAINSONG_DEV_SERVER_URL ?? "http://127.0.0.1:1420";
const rendererMode = process.env.PLAINSONG_RENDERER_MODE ?? "file";

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
let tray: Tray | null = null;
let minimizeToTrayEnabled = false;
let isQuitting = false;
let nativeShortcutController: NativeShortcutController | null = null;
let nativeShortcutAvailable = false;
let shortcutConflicts: ShortcutConflictInfo[] = [];

function qaLog(message: string, payload?: unknown): void {
  if (process.env.PLAINSONG_QA_PACKAGED_HOTKEY === "1") {
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
    toggleRecording?: string;
    toggleDictation?: string;
    openWindow?: string;
    quickExport?: string;
    focusSearch?: string;
  };
  transcription?: {
    dictationPushToTalk?: boolean;
    dictationHandsFreeEnabled?: boolean;
  };
  ui?: {
    minimizeToTray?: boolean;
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

// Menu-bar tray: a black-on-transparent template "P" the system recolors.
const TRAY_ICON_1X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAQAAABuvaSwAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAAqo0jMgAAAAd0SU1FB+oGFRMGN2ML3+kAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDYtMjFUMTk6MDY6NTUrMDA6MDCUuYwtAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA2LTIxVDE5OjA2OjU1KzAwOjAw5eQ0kQAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wNi0yMVQxOTowNjo1NSswMDowMLLxFU4AAAE5SURBVCjPldIxb1JhFMbx310uXLiABUKcbEKIgyRdTHRzde/Qiaazt0vgN9AP4DZz7AXTp2K4dTBycNAx2qGnCUGMoYuECLlTgcqHps5y8yf8973me83IPBdMaqokQCEVCY4k/esbzcG5aNxxoeqom8MWF2ENlbcc+G6ZfCNXUfTDRt6uoquFQ209vlbKH2jfQs/P//MaN3/ZmHef112jOByd+qHqlmgWPTRbOv3Tw2IMseDmrCMPbTNbDdXV81V0N32Zb8lrDpSP9xZznQ2zYUrJpW8s3752mlzJT5IWKWNGVd858n21xGU588lFkLEllkwFPDCWSLL9ZBgMrtD66lHKpq8G6zotwQWgivmuMQF7FM7GC58ryWf2jaa041PJSomtT0xPnrlc5jzySm/66QGikY3Af80v6B9NCQwaOnOZ/AAAAAElFTkSuQmCC";
const TRAY_ICON_2X =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAQAAAC0jZKKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAACYktHRAAAqo0jMgAAAAd0SU1FB+oGFRMGN2ML3+kAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDYtMjFUMTk6MDY6NTUrMDA6MDCUuYwtAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA2LTIxVDE5OjA2OjU1KzAwOjAw5eQ0kQAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wNi0yMVQxOTowNjo1NSswMDowMLLxFU4AAAH0SURBVEjH7ZbPSxRhGMc/Mzs7s64/IK0upmjpJRCCokOX6JCIt+gSKCh4EU+BIJ0DEfwbvEh1LsiLCBERHQqy9BD+II1SsQ6rjq2u67peXl5HZ3bnfXdH8LDf9/Llfd/nM8/zzjMvAxWdtwzfzAuSVOFg4+DgECeOTQzIc0QGl7+s8oNvzLFZGGz5ZtJkyXOVDmw594E35IAEV2ijg/uY7LDMFC9Z0qnDpI5hMuTFGD2VyjX6+CJWFukPSK6o6pmV4DHfajOvxdp/numhLRkaBIbrzEt0b1DRhXTIdtEH/2RCuCQjtKqDYS+kphnZFTd5pAPOhoD/sCJcjIc64KMQcJoN6dt1wPkQcI5d6Wt0wOE6ic5ECbZpkH49SnC9p8k+Rwm+S4twW0xFB65mAEf4aT5GBTYYokv4Fcb9H5Pa9XG28S4zyAhxAH7zlK/+EDVwAzcwMbCpo5FbdHIHgAzvec6noBA18BO6AAMLhwQm+6yyxjzTvGMnOEQNPMOkeBs5DkjjkiKFWyxEDbzAW6V9Hql1RQm9U95dUQFfWLChTNEEm0q7SgBbAS4ScEI6JxykDo5RK32t/nkXBidplL7Jk33ZeowrfwpTdOuG+0t8gMUlbtPjyRh+8YpZtjngO1ulZeqS5lDm6h1Z9vjHvegOpaLydAxNI4W4NraiLwAAAABJRU5ErkJggg==";

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Open Plainsong",
      click: () => {
        if (bootstrapComplete) {
          showAndFocusMainWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit Plainsong",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  if (tray) {
    return;
  }
  const icon = nativeImage.createFromDataURL(TRAY_ICON_1X);
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Plainsong");
  // A menu (not a popover) on click, per Apple HIG for menu-bar extras.
  tray.setContextMenu(buildTrayMenu());
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

// Anchor the overlay on the display the user is actually working on (the one
// under the cursor), inside that display's work area — which already excludes
// the menu bar and the notch safe-area on notched Macs. Without this the HUD
// always opens on the primary display even when work is on an external monitor.
function positionOverlayOnActiveDisplay(win: BrowserWindow): void {
  try {
    const point = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(point);
    const [winWidth, winHeight] = win.getSize();
    const isRecording = getWindowLabel(win) === "recording-overlay";
    const x = isRecording
      ? workArea.x + workArea.width - winWidth - 20
      : workArea.x + Math.round(workArea.width / 2 - winWidth / 2);
    const y = workArea.y + workArea.height - winHeight - (isRecording ? 20 : 40);
    win.setPosition(Math.round(x), Math.round(y));
  } catch (error) {
    console.error("[main] Failed to position overlay on active display:", error);
  }
}

function showOverlayWindow(win: BrowserWindow): void {
  positionOverlayOnActiveDisplay(win);
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
    case "app:set_minimize_to_tray": {
      const payload = (args ?? {}) as { enabled?: unknown };
      minimizeToTrayEnabled = payload.enabled === true;
      return { handled: true, result: null };
    }
    case "check_for_updates":
      return { handled: true, result: await checkForUpdatesInElectron() };
    case "install_update":
      await installUpdateInElectron();
      return { handled: true, result: null };
    case "get_update_status":
      return { handled: true, result: updateStatus };
    case "get_dictation_shortcut_capability_status":
      return {
        handled: true,
        result: { nativeShortcutAvailable },
      };
    case "get_shortcut_conflicts":
      return {
        handled: true,
        result: { conflicts: shortcutConflicts },
      };
    default:
      return { handled: false };
  }
}

type DictationShortcutPhase =
  | "idle"
  | "recording"
  | "stopping"
  | "transcribing"
  | "delivering"
  | "done"
  | "error";
type DictationShortcutSignal =
  | "pressed"
  | "released"
  | "cancelled"
  | "emergency_stop"
  | "watchdog_timeout";

async function handleDictationShortcutSignal(
  settings: AppSettings,
  signal: DictationShortcutSignal,
): Promise<void> {
  if (!ipcBridge) {
    return;
  }

  const behavior = resolveDictationShortcutBehavior(settings.transcription ?? {});
  const capability = resolveDictationShortcutCapability({
    nativeShortcutAvailable,
    behavior,
  });
  const decision = resolveDictationShortcutDecision({
    phase: dictationPhase as DictationShortcutPhase,
    behavior,
    capability,
    signal,
  });

  if (decision.action === "start") {
    qaLog("dictation shortcut start_dictation", { phase: dictationPhase, behavior, capability });
    await ipcBridge.invoke("start_dictation", {});
    return;
  }

  if (decision.action === "stop") {
    qaLog("dictation shortcut stop_dictation", {
      phase: dictationPhase,
      behavior,
      capability,
      stopReason: decision.stopReason ?? "toggle",
    });
    await ipcBridge.invoke("stop_dictation", {
      stopReason: decision.stopReason ?? "toggle",
    });
    return;
  }

  if (decision.action === "cancel") {
    qaLog("dictation shortcut force_stop_dictation", {
      phase: dictationPhase,
      behavior,
      capability,
      stopReason: decision.stopReason ?? "cancelled",
    });
    await ipcBridge.invoke("force_stop_dictation", {});
  }
}

/**
 * Handle a `dictation-vad-signal` event from the sidecar. Two distinct signals share
 * this event name (see rust-sidecar/src/audio.rs):
 *
 * - `silence_stop`: sustained silence was detected after speech during the active
 *   dictation session (the in-session `StreamingVadGate`/
 *   `drive_dictation_auto_stop_gate`, installed by `start_dictation`). Reuses the
 *   exact same stop path a manual toggle-stop takes (`stop_dictation` over the
 *   JSON-RPC bridge) so auto-stop behaves identically to a user-initiated stop
 *   regardless of activation mode (toggle, hold-to-talk, or hands-free).
 *
 * - `hands_free_start`: sustained speech was detected by the separate, always-on-
 *   when-enabled idle-time monitor (`AudioCapture::start_hands_free_monitor`), which
 *   only ever runs while no dictation session is active. Reuses the exact same start
 *   path the hotkey/native-helper activation flows call (`start_dictation` over the
 *   JSON-RPC bridge), so it passes through the identical `DictationSessionState::Idle`
 *   guard on the Rust side and can't double-start a session.
 */
async function handleDictationVadSignal(payload: unknown): Promise<void> {
  if (!ipcBridge) {
    return;
  }
  const signal =
    payload && typeof payload === "object" && "signal" in payload
      ? (payload as { signal?: unknown }).signal
      : undefined;

  if (signal === "silence_stop") {
    // Only stop if a session is actually in a stoppable phase; avoids racing a
    // signal from a session that already finished stopping through another path.
    if (dictationPhase !== "recording") {
      return;
    }
    qaLog("dictation vad auto-stop", { phase: dictationPhase, signal });
    await ipcBridge.invoke("stop_dictation", { stopReason: "auto_stop_silence" });
    return;
  }

  if (signal === "hands_free_start") {
    // Only start from a genuinely idle-like phase; avoids racing a stale signal
    // (e.g. emitted just before the monitor was stopped for an in-flight start
    // from another activation path) into double-starting a session. The Rust side
    // additionally re-checks `DictationSessionState::Idle` itself, so this is
    // defense-in-depth, not the only guard.
    if (dictationPhase !== "idle" && dictationPhase !== "done" && dictationPhase !== "error") {
      return;
    }
    qaLog("dictation hands-free auto-start", { phase: dictationPhase, signal });
    await ipcBridge.invoke("start_dictation", {});
    return;
  }
}

async function handleDictationGlobalShortcut(settings: AppSettings): Promise<void> {
  if (!shouldHandleDictationShortcutSource({ source: "electron", nativeShortcutAvailable })) {
    return;
  }
  await handleDictationShortcutSignal(settings, "pressed");
}

async function handleNativeDictationShortcutEvent(
  settings: AppSettings,
  rawEvent: NativeShortcutRawEvent,
): Promise<void> {
  if (!shouldHandleDictationShortcutSource({ source: "native", nativeShortcutAvailable })) {
    return;
  }

  const { signal } = normalizeNativeShortcutEvent(rawEvent);
  await handleDictationShortcutSignal(settings, signal);
}

function disposeNativeShortcutController(): void {
  nativeShortcutController?.dispose();
  nativeShortcutController = null;
  nativeShortcutAvailable = false;
}

function startNativeShortcutControllerIfNeeded(settings: AppSettings): void {
  disposeNativeShortcutController();

  const controller = startNativeMacosShortcutController({
    platform: process.platform,
    helperPath: getNativeShortcutHelperPath(),
    shortcut: settings.shortcuts?.toggleDictation,
    onEvent: (event) => {
      void handleNativeDictationShortcutEvent(settings, event).catch((error) => {
        console.error("[shortcuts] native dictation shortcut failed", error);
      });
    },
    onUnavailable: (status) => {
      console.warn("[shortcuts] native shortcut helper became unavailable", status);
      nativeShortcutAvailable = false;
    },
  });

  nativeShortcutController = controller;
  nativeShortcutAvailable = controller.status.available;
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

  startNativeShortcutControllerIfNeeded(settings);

  const conflicts = findConflictingShortcuts(settings.shortcuts ?? {});
  shortcutConflicts = conflicts;
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      console.warn("[shortcuts] conflict detected, skipping registration", {
        reason,
        skipped: conflict.label,
        shortcut: conflict.shortcut,
        keptOwner: conflict.conflictsWith,
      });
    }
  }
  broadcastRendererEvent("shortcut-conflicts-changed", { conflicts });
  const skippedFields = new Set(conflicts.map((conflict) => conflict.field));

  const dictationShortcut = skippedFields.has("toggleDictation")
    ? null
    : convertShortcutToAccelerator(settings.shortcuts?.toggleDictation);
  const openWindowShortcut = skippedFields.has("openWindow")
    ? null
    : convertShortcutToAccelerator(settings.shortcuts?.openWindow);
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

function getNativeShortcutHelperBinaryName(): string {
  return "plainsong-native-shortcut-helper";
}

function getNativeShortcutHelperPath(): string {
  const binaryName = getNativeShortcutHelperBinaryName();

  if (isDev) {
    return path.join(__dirname, "../dist-native", binaryName);
  }

  return path.join(process.resourcesPath, "shortcut-helper", binaryName);
}

function getSidecarBinaryName(): string {
  return process.platform === "win32" ? "plainsong-sidecar.exe" : "plainsong-sidecar";
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

  // Keep Plainsong alive in the menu-bar tray when the user opts in.
  win.on("close", (event) => {
    if (minimizeToTrayEnabled && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
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
  isQuitting = true;
  globalShortcut.unregisterAll();
  disposeNativeShortcutController();
  ipcBridge?.shutdown();
  tray?.destroy();
  tray = null;
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
      `The Plainsong sidecar binary was not found at:\n${sidecarPath}\n\n` +
      "Build it from source with:\n  bun run sidecar:build:release";
    console.error("[sidecar] missing binary", { sidecarPath });
    dialog.showErrorBox("Plainsong sidecar not found", message);
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

    if (eventName === "dictation-vad-signal") {
      void handleDictationVadSignal(payload).catch((error) => {
        console.error("[dictation] vad auto-stop signal failed", error);
      });
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

  try {
    const settings = (await ipcBridge.invoke("get_settings")) as AppSettings;
    minimizeToTrayEnabled = settings?.ui?.minimizeToTray === true;
  } catch (error) {
    console.error("[main] Failed to read minimize-to-tray setting:", error);
  }

  mainWindow = createMainWindow();
  createTray();
  bootstrapComplete = true;
}

void bootstrap();
