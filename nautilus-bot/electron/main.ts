import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  Tray,
  type IpcMainInvokeEvent,
} from "electron/main";
import { nativeImage, shell } from "electron/common";
import { execFile, spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { autoUpdater, type AppUpdater } from "electron-updater";
import {
  createDictationShortcutSignalRuntime,
  dictationShortcutFailureMessage,
  resolveDictationShortcutBehavior,
  resolveDictationShortcutCapability,
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
import {
  clampOverlaySize,
  resolveInitialOverlayAnchor,
  resolveOverlayBounds,
  resolveSavedOverlayAnchor,
  withOverlayDisplayMode,
  type OverlayKind,
  type OverlayPlacement,
  type OverlayWorkArea,
} from "./overlay-placement";
import {
  allowUpdaterDowngrade,
  effectiveUpdaterChannel,
  isMonotonicUpdateCandidate,
  macosUpdateRelauncherArgs,
  resolveUpdaterChannel,
  type UpdateChannel,
  updaterInstallBlockedByActiveMeeting,
  updaterResultHasAvailableUpdate,
} from "./updater-channel";
import {
  awaitMacosUpdateRelauncherReadiness,
  waitForMacosUpdateStaging,
} from "./macos-updater-staging";
import { runExplicitUpdaterInstallFlow } from "./updater-install-flow";
import {
  macAppSignatureIsUpdatable,
  parseCodesignTeamIdentifier,
  PLAINSONG_RELEASE_TEAM_ID,
} from "./macos-code-signature";
import { overlayVisibilityAllowed, resolveWindowUiSettings } from "./window-ui-settings";
import {
  clampWindowSizeToWorkArea,
  isFiniteWindowNumber,
} from "./window-bounds-policy";
import {
  isRendererUrl,
  RENDERER_HOST,
  RENDERER_SCHEME,
  rendererUrl,
  resolveRendererAssetPath,
  withRendererSecurityHeaders,
} from "./renderer-protocol";
import {
  RENDERER_READY_LOG_MESSAGE,
  shouldForwardRendererConsoleMessage,
} from "./renderer-readiness";
import { createDictationOverlayWindow, createRecordingOverlayWindow } from "./windows";
import {
  cloudLocationConfirmationDetail,
  parseCloudLocationRequest,
} from "./privileged-storage-locations";
import {
  CaptureAdmissionController,
  observeCaptureAdmissionForWindow,
} from "./capture-admission";
import { rendererPermissionAllowed } from "./renderer-permission-policy";
import { isAllowedExternalUrl } from "./external-url-policy";
import { trustedSenderFrameUrl } from "./trusted-sender";
import {
  finalizeMeetingWithinBudget,
  nextActiveMeetingRecordingId,
  resolveMeetingStopId,
  type MeetingFinalizationOutcome,
  type MeetingLifecycleEvent,
} from "./meeting-lifecycle";

// Packaging is the only thing that decides development mode. This used to also
// honour `NODE_ENV=development`, which meant an ambient environment variable
// could put a signed, packaged app into dev mode and, with the two renderer
// overrides below, point every privileged BrowserWindow at an arbitrary URL.
// A packaged build now ignores all three variables unconditionally.
const isDev = !app.isPackaged;
const devServerUrl = isDev
  ? (process.env.PLAINSONG_DEV_SERVER_URL ?? "http://127.0.0.1:1420")
  : "";
const rendererMode = isDev ? (process.env.PLAINSONG_RENDERER_MODE ?? "file") : "file";

// The dev server may only ever be a loopback origin, so an unpackaged run can't
// be pointed at a remote host either.
function isLoopbackDevServerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    return (
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

const devServerUrlIsUsable = isDev && rendererMode === "server" && isLoopbackDevServerUrl(devServerUrl);

if (isDev && rendererMode === "server" && !devServerUrlIsUsable) {
  console.error(
    "[dev] refusing non-loopback PLAINSONG_DEV_SERVER_URL; falling back to the bundled renderer",
    { url: devServerUrl }
  );
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

if (isDev) {
  app.commandLine.appendSwitch("no-proxy-server");
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>;localhost;127.0.0.1");
}

let mainWindow: BrowserWindow | null = null;
let ipcBridge: IpcBridge | null = null;
let dictationPhase = "idle";
let dictationShortcutFailureResetTimer: ReturnType<typeof setTimeout> | null = null;
const captureAdmission = new CaptureAdmissionController();
// Session id from the most recent `dictation-state-changed` event, used to
// drop stale VAD `silence_stop` signals emitted for an earlier session.
let dictationSessionId: number | null = null;
// Mirrors the sidecar's active meeting so a sidecar death can be reported
// against the right recording. Dictation already had this; meetings did not,
// so a crash mid-meeting left the UI showing "recording" indefinitely.
let activeMeetingRecordingId: string | null = null;
let updaterConfigured = false;
let updateReadyToInstall = false;
let bootstrapComplete = false;
let tray: Tray | null = null;
let minimizeToTrayEnabled = false;
// Mirrors of ui settings the main process owns. Each one was previously
// persisted and never read, so the switch moved but nothing happened.
let alwaysOnTopEnabled = false;
let showDictationOverlayEnabled = true;
let showRecordingOverlayEnabled = true;
let isQuitting = false;
let forcedQuitTimer: ReturnType<typeof setTimeout> | null = null;
const FORCED_QUIT_TIMEOUT_MS = 5_000;
const DICTATION_SHORTCUT_FAILURE_VISIBLE_MS = 8_000;
let nativeShortcutController: NativeShortcutController | null = null;
let nativeShortcutAvailable = false;
let appliedNativeShortcutConfig: string | null = null;
// Latest settings snapshot the shortcut handlers should act on. The native
// helper survives settings saves that don't change its shortcut, so its
// onEvent closure must not act on the settings captured at spawn time.
let latestShortcutSettings: AppSettings = {};
let shortcutConflicts: ShortcutConflictInfo[] = [];
// Mirrors the sidecar's recent-result list so the menu-bar menu can offer
// "Paste" for each without an async round trip while the menu is being built.
let recentDictationResults: Array<{ text: string }> = [];
let dictationPermissionSummary: string | null = null;

function qaLog(message: string, payload?: unknown): void {
  if (process.env.PLAINSONG_QA_PACKAGED_HOTKEY === "1") {
    console.log(`[qa] ${message}`, payload ?? "");
  }
}

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
  installBlockedReason?: "unsigned";
};

let updateStatus: UpdateStatusPayload = { status: "unknown" };
let updateInstallBlockedReason: "unsigned" | undefined;

type AppSettings = {
  shortcuts?: {
    toggleDictation?: string;
    openWindow?: string;
    repasteLastDictation?: string;
    recopyLastDictation?: string;
  };
  transcription?: {
    dictationPushToTalk?: boolean;
    dictationHandsFreeEnabled?: boolean;
  };
  ui?: {
    minimizeToTray?: boolean;
    alwaysOnTop?: boolean;
    showDictationPopup?: boolean;
    showRecordingPopup?: boolean;
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

// Single line of the transcript, short enough to read in a menu.
function summarizeTranscriptForMenu(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 48 ? `${collapsed.slice(0, 47)}\u2026` : collapsed;
}

function isDictationLive(): boolean {
  return dictationPhase === "primed" || dictationPhase === "recording";
}

function buildTrayMenu(): Menu {
  const dictationAccelerator = convertShortcutToAccelerator(
    latestShortcutSettings.shortcuts?.toggleDictation,
  );
  const live = isDictationLive();

  const recentItems: Parameters<typeof Menu.buildFromTemplate>[0] =
    recentDictationResults.length === 0
      ? [{ label: "No dictation results yet", enabled: false }]
      : recentDictationResults.map((result, index) => ({
          label: `Paste "${summarizeTranscriptForMenu(result.text)}"`,
          click: () => {
            void ipcBridge
              ?.invoke("repaste_dictation_result", { index })
              .catch((error) => {
                console.error("[tray] failed to re-paste dictation result", error);
              });
          },
        }));

  return Menu.buildFromTemplate([
    {
      // The accelerator is display-only here: the real binding is registered
      // through globalShortcut/the native helper, and letting the menu
      // register it too would double-fire the toggle.
      label: live ? "Stop Dictation" : "Start Dictation",
      accelerator: dictationAccelerator ?? undefined,
      registerAccelerator: false,
      enabled: bootstrapComplete && ipcBridge !== null,
      click: () => {
        void ipcBridge
          ?.invoke(live ? "stop_dictation" : "start_dictation", {})
          .catch((error) => {
            console.error("[tray] failed to toggle dictation", error);
          });
      },
    },
    { type: "separator" },
    { label: "Recent results", enabled: false },
    ...recentItems,
    { type: "separator" },
    {
      label: dictationPermissionSummary ?? "Checking permissions\u2026",
      enabled: false,
    },
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

// A live microphone must be visible somewhere on screen even when the HUD is
// hidden or the user is on another Space. The tray icon itself is a template
// image the system recolors, so it cannot carry the gold "setting down" moment
// — the neume beside it does, in the same notation vocabulary the HUD uses.
function refreshTray(): void {
  if (!tray) {
    return;
  }
  const live = isDictationLive();
  tray.setToolTip(live ? "Plainsong — dictation is live" : "Plainsong");
  if (process.platform === "darwin") {
    tray.setTitle(live ? "\u25C6" : "");
  }
  tray.setContextMenu(buildTrayMenu());
}

async function refreshDictationPermissionSummary(): Promise<void> {
  if (!ipcBridge) {
    return;
  }
  try {
    const diagnostics = (await ipcBridge.invokeSidecar(
      "get_permission_diagnostics",
    )) as {
      microphonePermissionReady?: boolean;
      cursorInsertionReady?: boolean;
    } | null;
    const microphoneReady = diagnostics?.microphonePermissionReady === true;
    const insertReady = diagnostics?.cursorInsertionReady === true;
    dictationPermissionSummary = microphoneReady
      ? insertReady
        ? "Microphone and insertion ready"
        : "Microphone ready · insertion needs permission"
      : "Microphone permission not granted";
  } catch (error) {
    console.error("[tray] failed to read permission diagnostics", error);
    dictationPermissionSummary = "Permission status unavailable";
  }
  refreshTray();
}

function createTray(): void {
  if (tray) {
    return;
  }
  const icon = nativeImage.createFromDataURL(TRAY_ICON_1X);
  icon.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_2X });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  // A menu (not a popover) on click, per Apple HIG for menu-bar extras.
  refreshTray();
  void refreshDictationPermissionSummary();
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

function updateRollbackError(candidateVersion: string): string {
  return `Update ${candidateVersion} was rejected because it is not newer than the running version ${app.getVersion()}.`;
}

function candidateIsMonotonic(info: UpdateInfoPayload | null | undefined): boolean {
  return Boolean(
    info?.version && isMonotonicUpdateCandidate(app.getVersion(), info.version),
  );
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
      const normalized = normalizeUpdateInfo(info);
      if (!candidateIsMonotonic(normalized)) {
        setUpdateStatus({
          status: "error",
          info: normalized ?? undefined,
          error: updateRollbackError(normalized?.version ?? "unknown"),
        });
        return;
      }
      setUpdateStatus({
        status: "updateAvailable",
        info: normalized,
        installBlockedReason: updateInstallBlockedReason,
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
      const normalized = normalizeUpdateInfo(info);
      if (!candidateIsMonotonic(normalized)) {
        updateReadyToInstall = false;
        setUpdateStatus({
          status: "error",
          info: normalized ?? undefined,
          error: updateRollbackError(normalized?.version ?? "unknown"),
        });
        return;
      }
      updateReadyToInstall = true;
      setUpdateStatus({
        status: "updateAvailable",
        info: normalized,
        progress: 100,
        installBlockedReason: updateInstallBlockedReason,
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

// Squirrel.Mac can only install updates into a code-signed app, and unsigned
// releases are a supported configuration (no Developer ID secrets in CI). An
// ad-hoc signature (what electron-builder applies on arm64 when no identity is
// available) cannot be updated either, so it counts as unsigned here.
//
// `codesign -dv` only DISPLAYS a signature and exits 0 for a broken or foreign
// one, so it was never evidence of anything: verify the seal, then require the
// team identifier to be ours. See macos-code-signature.ts.
let codeSignatureCheck: Promise<boolean> | null = null;

function runCodesign(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // `codesign` writes its display output to stderr, so both streams matter.
    execFile("/usr/bin/codesign", args, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}\n${stderr}` });
    });
  });
}

function isMacAppUpdatable(): Promise<boolean> {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return Promise.resolve(true);
  }

  if (!codeSignatureCheck) {
    const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
    // `--deep` walks every nested helper, which takes a moment on an Electron
    // bundle. It runs at most once per process and only on the update path.
    codeSignatureCheck = (async () => {
      const [verification, display] = await Promise.all([
        runCodesign(["--verify", "--strict", "--deep", bundlePath]),
        runCodesign(["-dv", "--verbose=4", bundlePath]),
      ]);
      const updatable = macAppSignatureIsUpdatable({
        verified: verification.ok,
        displayOutput: display.output,
      });
      if (!updatable) {
        console.warn("[updater] refusing to treat this bundle as updatable", {
          verified: verification.ok,
          teamIdentifier: parseCodesignTeamIdentifier(display.output),
          expectedTeamIdentifier: PLAINSONG_RELEASE_TEAM_ID,
        });
      }
      return updatable;
    })();
  }

  return codeSignatureCheck;
}

async function checkForUpdatesInElectron(): Promise<UpdateInfoPayload | null> {
  if (!app.isPackaged) {
    const error = "Updates are only available in packaged builds.";
    setUpdateStatus({ status: "error", error });
    throw new Error(error);
  }

  updateInstallBlockedReason = (await isMacAppUpdatable()) ? undefined : "unsigned";

  const configuredChannel = await getUpdateChannelFromSidecar();
  const channel = effectiveUpdaterChannel(configuredChannel, app.getVersion());
  // Stable must request `latest-mac.yml` (what electron-builder publishes);
  // requesting `stable-mac.yml` 404s with no fallback. See updater-channel.ts.
  autoUpdater.channel = resolveUpdaterChannel(channel);
  autoUpdater.allowPrerelease = channel === "beta";
  autoUpdater.allowDowngrade = allowUpdaterDowngrade(channel);

  const result = await autoUpdater.checkForUpdates();
  if (!updaterResultHasAvailableUpdate(result)) {
    return null;
  }
  const info = normalizeUpdateInfo(result?.updateInfo);
  if (!info || !candidateIsMonotonic(info)) {
    const error = updateRollbackError(info?.version ?? "unknown");
    updateReadyToInstall = false;
    setUpdateStatus({ status: "error", info: info ?? undefined, error });
    throw new Error(error);
  }
  return info;
}

async function installUpdateInElectron(): Promise<void> {
  if (!app.isPackaged) {
    throw new Error("Updates are only available in packaged builds.");
  }

  if (updaterInstallBlockedByActiveMeeting(activeMeetingRecordingId)) {
    throw new Error(
      "Finish the active meeting before installing the update so its recording can be finalized safely.",
    );
  }

  if (!updateStatus.info) {
    throw new Error("No downloaded or available update is ready to install.");
  }
  if (!candidateIsMonotonic(updateStatus.info)) {
    const error = updateRollbackError(updateStatus.info.version);
    updateReadyToInstall = false;
    setUpdateStatus({ status: "error", info: updateStatus.info, error });
    throw new Error(error);
  }

  if (!(await isMacAppUpdatable())) {
    const error =
      "This build's code signature is not a verified Plainsong release, so the " +
      "updater cannot install updates. " +
      "Download the new version from GitHub Releases instead.";
    setUpdateStatus({
      status: "error",
      info: updateStatus.info,
      error,
      installBlockedReason: "unsigned",
    });
    throw new Error(error);
  }

  const updateInfo = updateStatus.info;
  const appBundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
  const readyFilePath = path.join(
    app.getPath("temp"),
    `plainsong-update-relauncher-${process.pid}-${Date.now()}.ready`,
  );

  await runExplicitUpdaterInstallFlow({
    updater: autoUpdater,
    updateReadyToInstall,
    setDownloading: () => {
      setUpdateStatus({
        status: "downloading",
        info: updateInfo,
        progress: updateStatus.progress,
      });
    },
    setInstalling: () => {
      setUpdateStatus({ status: "installing", info: updateInfo });
    },
    waitForMacosStaging: () =>
      waitForMacosUpdateStaging({
        appBundlePath,
        expectedVersion: updateInfo.version,
        cachePath: path.join(app.getPath("home"), "Library", "Caches"),
      }),
    launchMacosRelauncher: async () => {
      const relauncher = spawn(
        "/bin/sh",
        macosUpdateRelauncherArgs(
          appBundlePath,
          updateInfo.version,
          readyFilePath,
        ),
        { detached: true, stdio: "ignore" },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          relauncher.once("spawn", resolve);
          relauncher.once("error", reject);
        });
        await awaitMacosUpdateRelauncherReadiness({
          child: relauncher,
          readyFilePath,
        });
        relauncher.unref();
      } finally {
        try {
          unlinkSync(readyFilePath);
        } catch {
          // The helper may have failed before creating its readiness marker.
        }
      }
    },
    quitApp: () => app.quit(),
    onFailure: (error) => {
      // Explicit consent applies only to this attempted install. If download,
      // staging, or helper handoff fails, an ordinary later quit must not
      // apply the abandoned update.
      updateReadyToInstall = false;
      const message =
        error instanceof Error ? error.message : "Failed to install update";
      setUpdateStatus({ status: "error", info: updateInfo, error: message });
    },
  });
}

// ── Overlay placement ────────────────────────────────────────────────────────
// The HUD is bottom-anchored: its bottom edge is what stays put, because the
// window is resized from the renderer on every live partial while the user is
// speaking. Anchors are stored as {bottom, left} for that reason — storing a
// top-left would let the pill walk down the screen as the estimate grows.

const OVERLAY_LABELS: Record<OverlayKind, string> = {
  dictation: "dictation-overlay",
  recording: "recording-overlay",
};
const overlayPlacements = new Map<OverlayKind, OverlayPlacement>();
let overlayPlacementSaveTimer: NodeJS.Timeout | null = null;

function getOverlayPlacementPath(): string {
  return path.join(app.getPath("userData"), "overlay-placement.json");
}

function loadOverlayPlacements(): void {
  const placementPath = getOverlayPlacementPath();
  if (!existsSync(placementPath)) {
    return;
  }
  try {
    const parsed = JSON.parse(readFileSync(placementPath, "utf8")) as Record<
      string,
      unknown
    >;
    for (const kind of ["dictation", "recording"] as OverlayKind[]) {
      const entry = parsed[kind];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const { bottom, left, displayMode } = entry as Record<string, unknown>;
      // A dragged anchor and a chosen display mode are saved independently:
      // an entry may legitimately carry only one of them.
      const hasAnchor = typeof bottom === "number" && typeof left === "number";
      const hasDisplayMode = typeof displayMode === "string";
      if (!hasAnchor && !hasDisplayMode) {
        continue;
      }
      overlayPlacements.set(kind, {
        ...(hasAnchor ? { bottom, left } : {}),
        ...(hasDisplayMode ? { displayMode } : {}),
      });
    }
  } catch (error) {
    console.error("[main] Failed to read saved overlay placement:", error);
  }
}

function scheduleOverlayPlacementSave(): void {
  // The `moved` event fires continuously while a drag is in progress; only the
  // resting position is worth writing to disk.
  if (overlayPlacementSaveTimer) {
    clearTimeout(overlayPlacementSaveTimer);
  }
  overlayPlacementSaveTimer = setTimeout(() => {
    overlayPlacementSaveTimer = null;
    try {
      writeFileSync(
        getOverlayPlacementPath(),
        JSON.stringify(Object.fromEntries(overlayPlacements)),
        "utf8",
      );
    } catch (error) {
      console.error("[main] Failed to persist overlay placement:", error);
    }
  }, 400);
}

function getOverlayKind(win: BrowserWindow | null): OverlayKind | null {
  const label = getWindowLabel(win);
  if (label === OVERLAY_LABELS.dictation) {
    return "dictation";
  }
  if (label === OVERLAY_LABELS.recording) {
    return "recording";
  }
  return null;
}

function getWorkAreas(): OverlayWorkArea[] {
  return screen.getAllDisplays().map((display) => display.workArea);
}

// Anchor the overlay on the display the user is actually working on (the one
// under the cursor), inside that display's work area — which already excludes
// the menu bar and the notch safe-area on notched Macs. Without this the HUD
// always opens on the primary display even when work is on an external monitor.
// A position the user DRAGGED the HUD to wins over the default anchor as long
// as it is still on a connected display; a placement that only remembers a
// display mode does not count as one (see `resolveSavedOverlayAnchor`).
function resolveOverlayAnchor(
  kind: OverlayKind,
  size: { width: number; height: number },
): { anchor: { bottom: number; left: number }; workArea: OverlayWorkArea } {
  const savedAnchor = resolveSavedOverlayAnchor(
    overlayPlacements.get(kind),
    getWorkAreas(),
  );
  if (savedAnchor) {
    return {
      anchor: savedAnchor,
      workArea: screen.getDisplayNearestPoint({
        x: Math.round(savedAnchor.left),
        y: Math.round(savedAnchor.bottom),
      }).workArea,
    };
  }

  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return {
    anchor: resolveInitialOverlayAnchor({ workArea, size, kind }),
    workArea,
  };
}

// Bounds this process set, per overlay. `moved` fires for programmatic moves
// too, and treating those as "the user dragged it here" would pin the HUD to
// whichever display it last opened on and stop it following the cursor.
const lastProgrammaticOverlayOrigin = new Map<OverlayKind, { x: number; y: number }>();

function applyOverlayBounds(
  win: BrowserWindow,
  kind: OverlayKind,
  bounds: { x: number; y: number; width: number; height: number },
): void {
  lastProgrammaticOverlayOrigin.set(kind, { x: bounds.x, y: bounds.y });
  win.setBounds(bounds);
}

function positionOverlayOnActiveDisplay(win: BrowserWindow): void {
  const kind = getOverlayKind(win);
  if (!kind) {
    return;
  }

  try {
    const [width, height] = win.getSize();
    const { anchor, workArea } = resolveOverlayAnchor(kind, { width, height });
    applyOverlayBounds(
      win,
      kind,
      resolveOverlayBounds({ workArea, size: { width, height }, anchor }),
    );
  } catch (error) {
    console.error("[main] Failed to position overlay on active display:", error);
  }
}

// Pair every renderer-driven size change with a reposition so the pill's bottom
// edge stays fixed and the window can never grow past the bottom of the work
// area. Setting the size alone grows the HUD downward off screen while the user
// is still speaking.
// The requested size is clamped to the per-kind maximum FIRST: resolveOverlayBounds
// only clamps to the work area, which for a renderer asking for 5000x5000 means a
// full-screen always-on-top window rather than an overlay.
function resizeOverlayKeepingBottomEdge(
  win: BrowserWindow,
  kind: OverlayKind,
  size: { width: number; height: number },
): void {
  try {
    const current = win.getBounds();
    const { workArea } = screen.getDisplayNearestPoint({
      x: Math.round(current.x + current.width / 2),
      y: Math.round(current.y + current.height / 2),
    });
    applyOverlayBounds(
      win,
      kind,
      resolveOverlayBounds({
        workArea,
        size: clampOverlaySize(kind, size),
        anchor: { bottom: current.y + current.height, left: current.x },
      }),
    );
  } catch (error) {
    console.error("[main] Failed to resize overlay:", error);
  }
}

/**
 * Adopt the ui settings the main process is responsible for.
 *
 * Called at bootstrap and on every `settings-changed` broadcast, so any writer
 * (Settings view, another window, a direct save) takes effect without the
 * renderer having to push each field separately.
 */
function applyUiSettings(settings: AppSettings | null | undefined): void {
  const resolved = resolveWindowUiSettings(settings);
  minimizeToTrayEnabled = resolved.minimizeToTray;
  alwaysOnTopEnabled = resolved.alwaysOnTop;
  showDictationOverlayEnabled = resolved.showDictationOverlay;
  showRecordingOverlayEnabled = resolved.showRecordingOverlay;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(alwaysOnTopEnabled);
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

function createOverlayWindow(kind: OverlayKind): BrowserWindow {
  const overlay =
    kind === "dictation"
      ? createDictationOverlayWindow()
      : createRecordingOverlayWindow();
  (overlay as BrowserWindow & { _label?: string })._label = OVERLAY_LABELS[kind];
  configureWindowSecurity(overlay);
  // The dictation HUD is mostly transparent padding around a small card.
  // Without click-through that band swallows clicks meant for the app
  // underneath; hit testing is re-enabled from the renderer only while the
  // pointer is over the card itself (see __window_set_ignore_mouse_events__).
  // The recording chip has no such handler yet, so it stays hit-testable
  // rather than becoming silently uninteractive.
  if (kind === "dictation") {
    overlay.setIgnoreMouseEvents(true, { forward: true });
  }

  overlay.on("moved", () => {
    if (overlay.isDestroyed()) {
      return;
    }
    const bounds = overlay.getBounds();
    const programmatic = lastProgrammaticOverlayOrigin.get(kind);
    if (programmatic && programmatic.x === bounds.x && programmatic.y === bounds.y) {
      return;
    }
    overlayPlacements.set(kind, {
      ...overlayPlacements.get(kind),
      bottom: bounds.y + bounds.height,
      left: bounds.x,
    });
    scheduleOverlayPlacementSave();
  });

  const query = { overlay: kind };
  if (devServerUrlIsUsable) {
    void overlay.loadURL(`${devServerUrl}?overlay=${kind}`);
  } else {
    void overlay.loadURL(rendererUrl(query));
  }

  return overlay;
}

// Both overlays are created (hidden) at bootstrap so the first hotkey press
// shows an already-mounted React tree instead of waiting on a cold boot behind
// did-finish-load.
function getOrCreateOverlayWindow(kind: OverlayKind): BrowserWindow {
  const existing = findWindowByLabel(OVERLAY_LABELS[kind]);
  if (existing && !existing.isDestroyed()) {
    return existing;
  }
  return createOverlayWindow(kind);
}

function prepareOverlayWindows(): void {
  for (const kind of ["dictation", "recording"] as OverlayKind[]) {
    try {
      getOrCreateOverlayWindow(kind);
    } catch (error) {
      console.error(`[main] Failed to pre-create ${kind} overlay window:`, error);
    }
  }
}

async function handleLocalCommand(
  event: IpcMainInvokeEvent,
  command: string,
  args: unknown
): Promise<{ handled: boolean; result?: unknown }> {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);

  /**
   * Gate every native modal this handler can open.
   *
   * A modal is parented to the window that asked for it and blocks that window
   * until it is dismissed, and neither fact was checked here. Any window could
   * ask — including a hidden, non-focusable overlay, which parents a modal to a
   * window the user cannot see or dismiss — and nothing required a user
   * gesture, so a renderer could put an unprompted folder picker carrying
   * Plainsong's name in front of the user at any moment. `begin_meeting_capture`
   * already had both guards; the storage-location commands, which are the ones
   * that hand a directory to a privileged sidecar approval, did not.
   *
   * The gesture is consumed BEFORE the dialog opens, and is single-use: two
   * dialogs need two clicks.
   */
  const requireMainWindowGesture = (action: string): BrowserWindow => {
    if (!senderWindow || senderWindow !== mainWindow) {
      throw new Error(`${action} can only be requested from the main Plainsong window`);
    }
    const route = event.senderFrame?.url ?? senderWindow.webContents.getURL();
    captureAdmission.consume(senderWindow.id, route);
    return senderWindow;
  };

  const chooseDirectory = async (
    parent: BrowserWindow,
    title: string,
  ): Promise<string | null> => {
    const result = await dialog.showOpenDialog(parent, {
      title,
      buttonLabel: "Choose folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  switch (command) {
    case "__window_set_size__": {
      if (!senderWindow) {
        return { handled: true, result: null };
      }
      const payload = (args ?? {}) as { width?: unknown; height?: unknown };
      // NaN and Infinity both satisfy `typeof x === "number"`, which was the
      // only guard here.
      if (
        !isFiniteWindowNumber(payload.width) ||
        !isFiniteWindowNumber(payload.height)
      ) {
        return { handled: true, result: null };
      }
      const size = { width: payload.width, height: payload.height };
      const overlayKind = getOverlayKind(senderWindow);
      if (overlayKind) {
        resizeOverlayKeepingBottomEdge(senderWindow, overlayKind, size);
      } else {
        // The main window is resizable and has no persisted bounds, so a size
        // larger than the display it is on cannot be recovered from without a
        // relaunch. Clamp to the work area of the display the window actually
        // occupies, not the primary display.
        const [minWidth, minHeight] = senderWindow.getMinimumSize();
        const { workArea } = screen.getDisplayMatching(senderWindow.getBounds());
        const clamped = clampWindowSizeToWorkArea(size, workArea, {
          width: minWidth,
          height: minHeight,
        });
        senderWindow.setSize(clamped.width, clamped.height, true);
      }
      return { handled: true, result: null };
    }
    case "__window_set_ignore_mouse_events__": {
      // The overlay is a transparent band around a small card; the renderer
      // re-enables hit testing only while the pointer is over the card itself.
      if (!senderWindow || !getOverlayKind(senderWindow)) {
        return { handled: true, result: null };
      }
      const payload = (args ?? {}) as { ignore?: unknown };
      senderWindow.setIgnoreMouseEvents(payload.ignore !== false, { forward: true });
      return { handled: true, result: null };
    }
    case "__overlay_placement__": {
      const kind = getOverlayKind(senderWindow);
      return {
        handled: true,
        result: kind ? (overlayPlacements.get(kind) ?? null) : null,
      };
    }
    case "__overlay_set_display_mode__": {
      // Records the mode ONLY. Toggling Compact/Expand is cosmetic; inventing a
      // {bottom,left} from the window's current bounds here would be
      // indistinguishable from a drag afterwards and would pin the HUD to one
      // display permanently.
      const kind = getOverlayKind(senderWindow);
      const payload = (args ?? {}) as { displayMode?: unknown };
      if (kind && typeof payload.displayMode === "string") {
        overlayPlacements.set(
          kind,
          withOverlayDisplayMode(
            overlayPlacements.get(kind),
            payload.displayMode,
          ),
        );
        scheduleOverlayPlacementSave();
      }
      return { handled: true, result: null };
    }
    case "__window_set_position__": {
      // Only the overlays move themselves — they are the windows this process
      // positions programmatically anyway. The main window's position belongs
      // to the user: it is not persisted, so a renderer that could park it
      // off-screen made the app unusable until it was quit and relaunched, and
      // no renderer code has ever needed to move it.
      const overlayKind = senderWindow ? getOverlayKind(senderWindow) : null;
      if (!senderWindow || !overlayKind) {
        return { handled: true, result: null };
      }
      const payload = (args ?? {}) as { x?: unknown; y?: unknown };
      if (!isFiniteWindowNumber(payload.x) || !isFiniteWindowNumber(payload.y)) {
        return { handled: true, result: null };
      }
      // Route through the same bottom-anchored clamp every other overlay move
      // uses, so the window stays inside the work area of the display it is
      // being moved to and `moved` is not mistaken for a user drag.
      const x = Math.round(payload.x);
      const y = Math.round(payload.y);
      const current = senderWindow.getBounds();
      const { workArea } = screen.getDisplayNearestPoint({ x, y });
      applyOverlayBounds(
        senderWindow,
        overlayKind,
        resolveOverlayBounds({
          workArea,
          size: { width: current.width, height: current.height },
          anchor: { bottom: y + current.height, left: x },
        }),
      );
      return { handled: true, result: null };
    }
    case "__window_hide__":
      senderWindow?.hide();
      return { handled: true, result: null };
    case "__window_show__": {
      if (!senderWindow) {
        return { handled: true, result: null };
      }
      // An overlay may only put itself on screen while the main process still
      // believes that overlay is enabled. Honoring the renderer unconditionally
      // made showInactive() an always-on-top, visible-on-full-screen window the
      // user had explicitly turned off — see overlayVisibilityAllowed.
      const overlayKind = getOverlayKind(senderWindow);
      if (
        overlayKind &&
        !overlayVisibilityAllowed(overlayKind, {
          showDictationOverlay: showDictationOverlayEnabled,
          showRecordingOverlay: showRecordingOverlayEnabled,
        })
      ) {
        return { handled: true, result: null };
      }
      senderWindow.showInactive();
      return { handled: true, result: null };
    }
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
    case "select_export_location": {
      const parent = requireMainWindowGesture("Choosing an export folder");
      const selectedPath = await chooseDirectory(
        parent,
        "Choose a dedicated export folder",
      );
      if (!selectedPath) {
        return { handled: true, result: null };
      }
      if (!ipcBridge) {
        throw new Error("Storage approval service is not ready");
      }
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar("approve_export_location_privileged", {
          path: selectedPath,
        }),
      };
    }
    case "select_backup_location": {
      const parent = requireMainWindowGesture("Choosing a backup folder");
      const selectedPath = await chooseDirectory(
        parent,
        "Choose a dedicated backup folder",
      );
      if (!selectedPath) {
        return { handled: true, result: null };
      }
      if (!ipcBridge) {
        throw new Error("Storage approval service is not ready");
      }
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar("approve_backup_location_privileged", {
          path: selectedPath,
        }),
      };
    }
    case "select_cloud_backup_location": {
      const request = parseCloudLocationRequest(args);
      if (!ipcBridge) {
        throw new Error("Storage approval service is not ready");
      }
      // One gesture for this command, whichever of the two dialogs it opens.
      const parent = requireMainWindowGesture("Choosing a cloud backup destination");
      if (request.provider === "i_cloud") {
        const selectedPath = await chooseDirectory(
          parent,
          "Choose an iCloud backup folder",
        );
        if (!selectedPath) {
          return { handled: true, result: null };
        }
        return {
          handled: true,
          result: await ipcBridge.invokeSidecar(
            "approve_cloud_backup_location_privileged",
            {
              provider: request.provider,
              path: selectedPath,
              folder: request.folder,
            },
          ),
        };
      }

      const messageOptions: Electron.MessageBoxOptions = {
        type: "warning",
        title: "Confirm cloud backup destination",
        message: "Allow this cloud destination?",
        detail: cloudLocationConfirmationDetail(request),
        buttons: ["Cancel", "Allow destination"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const confirmation = await dialog.showMessageBox(parent, messageOptions);
      if (confirmation.response !== 1) {
        return { handled: true, result: null };
      }
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar(
          "approve_cloud_backup_location_privileged",
          {
            provider: request.provider,
            remoteName: request.remoteName,
            folder: request.folder,
          },
        ),
      };
    }
    case "begin_meeting_capture": {
      if (!senderWindow || senderWindow !== mainWindow) {
        throw new Error("Meeting capture can only start from the main Plainsong window");
      }
      if (!ipcBridge) {
        throw new Error("Meeting capture service is not ready");
      }
      const route = event.senderFrame?.url ?? senderWindow.webContents.getURL();
      const grant = captureAdmission.consume(senderWindow.id, route);
      const payload = (args ?? {}) as { options?: unknown };
      const suppliedOptions =
        payload.options && typeof payload.options === "object"
          ? (payload.options as Record<string, unknown>)
          : {};
      const result = (await ipcBridge.invoke("start_recording", {
        options: {
          ...suppliedOptions,
          consentPromptShown: true,
          admissionNonce: grant.nonce,
        },
      })) as { recordingId?: unknown };
      if (typeof result?.recordingId !== "string" || !result.recordingId) {
        throw new Error("Meeting capture did not return a recording ID");
      }
      activeMeetingRecordingId = result.recordingId;
      return { handled: true, result: result.recordingId };
    }
    case "end_meeting_capture": {
      if (!senderWindow) {
        throw new Error("Meeting capture stop requires a Plainsong window");
      }
      if (!ipcBridge) {
        throw new Error("Meeting capture service is not ready");
      }
      const route = event.senderFrame?.url ?? senderWindow.webContents.getURL();
      captureAdmission.consume(senderWindow.id, route);
      const payload = (args ?? {}) as { recordingId?: unknown };
      const requestedRecordingId =
        typeof payload.recordingId === "string" ? payload.recordingId : null;
      const recordingId = resolveMeetingStopId(
        activeMeetingRecordingId,
        requestedRecordingId,
      );
      await ipcBridge.invokeSidecar("stop_recording", { recordingId });
      return { handled: true, result: null };
    }
    default:
      return { handled: false };
  }
}

type DictationShortcutPhase =
  | "idle"
  | "primed"
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

// Stateful signal runtime: handles a hold-to-talk release that lands before
// the sidecar's phase "recording" event is observed (rapid tap) and arms a
// max-hold watchdog, so a dropped release can never leave the microphone
// recording forever. Observed dictation phases must be forwarded into
// runtime.onPhase (see ipcBridge.onEvent/onTerminated below) so the watchdog
// tracks the session it guards.
const dictationShortcutSignalRuntime = createDictationShortcutSignalRuntime({
  getPhase: () => dictationPhase as DictationShortcutPhase,
  invoke: (command, args) => {
    if (!ipcBridge) {
      return Promise.reject(new Error("IPC bridge is not ready"));
    }
    return ipcBridge.invoke(command, args);
  },
  log: qaLog,
});

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
  await dictationShortcutSignalRuntime.handleSignal({ behavior, capability, signal });
}

function scheduleDictationErrorReset(): void {
  if (dictationShortcutFailureResetTimer) {
    clearTimeout(dictationShortcutFailureResetTimer);
  }
  dictationShortcutFailureResetTimer = setTimeout(() => {
    dictationShortcutFailureResetTimer = null;
    if (dictationPhase !== "error") {
      return;
    }
    dictationPhase = "idle";
    dictationShortcutSignalRuntime.onPhase("idle");
    broadcastRendererEvent("dictation-state-changed", { phase: "idle" });
    BrowserWindow.getAllWindows()
      .filter((window) => getOverlayKind(window) === "dictation")
      .forEach((window) => window.hide());
    refreshTray();
  }, DICTATION_SHORTCUT_FAILURE_VISIBLE_MS);
}

function surfaceDictationShortcutFailure(source: string, error: unknown): void {
  console.error(`[shortcuts] ${source} failed`, error);
  const payload = {
    phase: "error",
    message: dictationShortcutFailureMessage(error),
  };
  dictationPhase = "error";
  dictationShortcutSignalRuntime.onPhase("error");
  refreshTray();
  if (showDictationOverlayEnabled) {
    showOverlayWindow(getOrCreateOverlayWindow("dictation"));
  }
  broadcastRendererEvent("dictation-state-changed", payload);
  scheduleDictationErrorReset();
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
    // Scope the auto-stop to the session that emitted it: a delayed signal
    // from an already-stopped session must not stop a newer session that
    // started in the meantime. The sidecar re-checks the sessionId too.
    const payloadSessionId =
      payload && typeof payload === "object" && "sessionId" in payload
        ? (payload as { sessionId?: unknown }).sessionId
        : undefined;
    if (
      typeof payloadSessionId === "number" &&
      dictationSessionId !== null &&
      payloadSessionId !== dictationSessionId
    ) {
      qaLog("dictation vad auto-stop dropped (stale session)", {
        payloadSessionId,
        activeSessionId: dictationSessionId,
      });
      return;
    }
    qaLog("dictation vad auto-stop", { phase: dictationPhase, signal });
    await ipcBridge.invoke("stop_dictation", {
      stopReason: "auto_stop_silence",
      ...(typeof payloadSessionId === "number" ? { sessionId: payloadSessionId } : {}),
    });
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
    // `handsFreeTrigger` is what entitles this start — and only this start — to
    // be seeded from the monitor's pre-roll ring. The sidecar stops the monitor
    // on every start, so the ring is always fresh; without the flag a hotkey
    // press would splice the two seconds before the press onto the transcript.
    await ipcBridge.invoke("start_dictation", {
      options: { handsFreeTrigger: true },
    });
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
  qaLog("dictation native shortcut event", {
    type: rawEvent.type,
    key: rawEvent.key,
    phase: dictationPhase,
    nativeShortcutAvailable,
  });
  if (!shouldHandleDictationShortcutSource({ source: "native", nativeShortcutAvailable })) {
    return;
  }

  const { signal } = normalizeNativeShortcutEvent(rawEvent);
  await handleDictationShortcutSignal(settings, signal);
}

// Keeps the flag and the renderers in sync: Settings copy (e.g. the
// hold-to-talk hint) reflects a helper crash instead of promising a
// release-to-stop that no longer works.
function setNativeShortcutAvailable(next: boolean): void {
  if (nativeShortcutAvailable === next) {
    return;
  }
  nativeShortcutAvailable = next;
  broadcastRendererEvent("dictation-shortcut-capability-changed", {
    nativeShortcutAvailable: next,
  });
}

function disposeNativeShortcutController(): void {
  nativeShortcutController?.dispose();
  nativeShortcutController = null;
  appliedNativeShortcutConfig = null;
  setNativeShortcutAvailable(false);
}

function startNativeShortcutControllerIfNeeded(settings: AppSettings): void {
  const desiredConfig = settings.shortcuts?.toggleDictation ?? null;
  // Only respawn the helper when its shortcut actually changed (or it died).
  // An unconditional respawn on every settings save would reset the helper's
  // key-down tracking, swallowing the release of a hold that is in progress.
  if (
    nativeShortcutController &&
    nativeShortcutController.status.available &&
    appliedNativeShortcutConfig === desiredConfig
  ) {
    return;
  }

  disposeNativeShortcutController();

  const controller = startNativeMacosShortcutController({
    platform: process.platform,
    helperPath: getNativeShortcutHelperPath(),
    shortcut: settings.shortcuts?.toggleDictation,
    onEvent: (event) => {
      void handleNativeDictationShortcutEvent(latestShortcutSettings, event).catch((error) => {
        surfaceDictationShortcutFailure("native dictation shortcut", error);
      });
    },
    onUnavailable: (status) => {
      // A queued crash-exit from an older, already-replaced helper must not
      // mark the current helper unavailable.
      if (nativeShortcutController !== controller) {
        return;
      }
      console.warn("[shortcuts] native shortcut helper became unavailable", status);
      setNativeShortcutAvailable(false);
    },
  });

  nativeShortcutController = controller;
  appliedNativeShortcutConfig = desiredConfig;
  setNativeShortcutAvailable(controller.status.available);
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

  latestShortcutSettings = settings;
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
  // Recovery bindings: when an insert lands in the wrong app or silently
  // fails, these put the last result back without the user re-speaking it.
  const repasteShortcut = skippedFields.has("repasteLastDictation")
    ? null
    : convertShortcutToAccelerator(settings.shortcuts?.repasteLastDictation);
  const recopyShortcut = skippedFields.has("recopyLastDictation")
    ? null
    : convertShortcutToAccelerator(settings.shortcuts?.recopyLastDictation);
  const behavior = resolveDictationShortcutBehavior(settings.transcription ?? {});
  const usesPressOnlyElectronFallback = behavior === "hold_to_talk";

  globalShortcut.unregisterAll();

  if (dictationShortcut) {
    const registered = globalShortcut.register(dictationShortcut, () => {
      void handleDictationGlobalShortcut(settings).catch((error) => {
        surfaceDictationShortcutFailure("dictation shortcut", error);
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

  for (const [field, accelerator, command] of [
    ["repasteLastDictation", repasteShortcut, "repaste_dictation_result"],
    ["recopyLastDictation", recopyShortcut, "recopy_dictation_result"],
  ] as const) {
    if (!accelerator) {
      continue;
    }
    const registered = globalShortcut.register(accelerator, () => {
      void ipcBridge?.invoke(command, { index: 0 }).catch((error) => {
        // A missing result (nothing dictated yet) is the common case here and
        // is reported by the sidecar as an error; it is not worth a dialog.
        console.warn("[shortcuts] dictation recovery shortcut failed", {
          command,
          error,
        });
      });
    });

    if (!registered) {
      console.error("[shortcuts] failed to register dictation recovery shortcut", {
        reason,
        field,
        accelerator,
      });
    }
  }

  refreshTray();
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

    if (isRendererUrl(rawUrl)) {
      return true;
    }

    if (devServerUrlIsUsable) {
      return url.origin === new URL(devServerUrl).origin;
    }

    return false;
  } catch {
    return false;
  }
}

// Electron approves renderer permission requests by default. Plainsong's
// renderer processes inherit the app's microphone entitlement, so an
// unexpected origin loaded into a window would otherwise be able to open the
// microphone under the grant the user gave Plainsong. Only the packaged
// renderer origin (or the loopback dev server) may ask, and only for media.
function isTrustedRendererOrigin(rawUrl: string | undefined | null): boolean {
  if (!rawUrl) {
    return false;
  }
  return isRendererAppUrl(rawUrl);
}

function installRendererPermissionHandlers(): void {
  const defaultSession = session.defaultSession;

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requestUrl =
      "securityOrigin" in details && typeof details.securityOrigin === "string"
        ? details.securityOrigin
        : details.requestingUrl;
    const allowed = rendererPermissionAllowed(
      permission,
      { requestingOrigin: requestUrl, isMainFrame: details.isMainFrame },
      isTrustedRendererOrigin,
    );

    if (!allowed) {
      console.warn("[security] denied renderer permission request", {
        permission,
        url: requestUrl,
      });
    }

    callback(allowed);
  });

  defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) =>
      rendererPermissionAllowed(
        permission,
        {
          requestingOrigin: details.securityOrigin ?? requestingOrigin,
          isMainFrame: details.isMainFrame,
        },
        isTrustedRendererOrigin,
      ),
    );
}

function configureWindowSecurity(win: BrowserWindow): void {
  observeCaptureAdmissionForWindow(win, captureAdmission);

  // Both of these hand a renderer-supplied URL to the user's browser, which is
  // the only egress the renderer controls. `isAllowedExternalUrl` is a host
  // allowlist, not a protocol check — see external-url-policy.ts.
  const openExternalIfAllowed = (url: string, source: string): void => {
    if (!isAllowedExternalUrl(url)) {
      console.warn("[security] refused to open an external URL", { source, url });
      return;
    }
    void shell.openExternal(url);
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url, "window-open");

    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isRendererAppUrl(url)) {
      return;
    }

    event.preventDefault();
    openExternalIfAllowed(url, "will-navigate");
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
    // The overlay windows are created hidden at bootstrap and outlive the main
    // window, so `window-all-closed` never fires; keep the non-macOS "closing
    // the window quits the app" behavior explicit rather than relying on it.
    if (process.platform !== "darwin" && !isQuitting) {
      app.quit();
    }
  });

  // Keep Plainsong alive in the menu-bar tray when the user opts in.
  win.on("close", (event) => {
    if (minimizeToTrayEnabled && !isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.webContents.on(
    "console-message",
    ({ level, message, lineNumber, sourceId }) => {
      if (!shouldForwardRendererConsoleMessage(message, isDev)) {
        return;
      }
      if (isDev) {
        console.log("[renderer:console]", {
          level,
          message,
          lineNumber,
          sourceId,
        });
        return;
      }
      console.log(RENDERER_READY_LOG_MESSAGE);
    },
  );

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
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[renderer] render-process-gone", details);
    });
    if (devServerUrlIsUsable) {
      void win.loadURL(devServerUrl);
    } else {
      void win.loadURL(rendererUrl());
    }
  } else {
    void win.loadURL(rendererUrl());
  }

  // Applied here rather than at the bootstrap call site so the setting survives
  // the window being recreated (dock reactivate, and the non-macOS quit path).
  if (alwaysOnTopEnabled) {
    win.setAlwaysOnTop(true);
  }

  return win;
}

process.on("uncaughtException", (error) => {
  console.error("[main] uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandled rejection", reason);
});

// Quitting with a meeting still running used to tear the sidecar down while the
// capture and WAV-writer threads were live, so everything since the last
// five-second header checkpoint was lost and the meeting was left marked
// errored. Stop and finalize first, then continue the normal quit.
async function finalizeActiveMeetingBeforeQuit(): Promise<MeetingFinalizationOutcome> {
  if (!activeMeetingRecordingId || !ipcBridge) {
    return { status: "confirmed" };
  }

  const recordingId = activeMeetingRecordingId;
  console.log("[main] finalizing active meeting before quit", { recordingId });

  const result = await finalizeMeetingWithinBudget(() =>
    ipcBridge!.invokeSidecar("stop_recording", { recordingId }).then(() => undefined),
  );
  if (result.status === "confirmed") {
    console.log("[main] meeting finalized before quit", { recordingId });
  } else if (result.status === "timed_out") {
    console.error("[main] meeting finalization remains recoverable after bounded quit", {
      recordingId,
    });
  } else {
    console.error("[main] meeting finalization failed; cancelling quit", {
      recordingId,
      error: result.error,
    });
  }
  return result;
}

app.on("before-quit", (event) => {
  // Take one pass to finalize the meeting, then re-issue the quit. The guard is
  // `isQuitting`, which is already set below, so the second pass falls straight
  // through instead of looping.
  if (!isQuitting && activeMeetingRecordingId && ipcBridge) {
    event.preventDefault();
    isQuitting = true;
    void finalizeActiveMeetingBeforeQuit().then((result) => {
      if (result.status === "failed") {
        isQuitting = false;
        const reason =
          result.error instanceof Error
            ? result.error.message
            : "The meeting could not be finalized safely.";
        dialog.showErrorBox(
          "Finish the meeting before quitting",
          `${reason}\n\nPlainsong stayed open so you can retry without losing the meeting.`,
        );
        showAndFocusMainWindow();
        return;
      }
      app.quit();
    });
    return;
  }

  isQuitting = true;
  // Electron's graceful quit can remain stuck after every window disappears.
  // Keep the normal lifecycle first so renderers and the sidecar can clean up,
  // then force only this process to exit if macOS never completes the quit.
  if (!forcedQuitTimer) {
    forcedQuitTimer = setTimeout(() => {
      console.error("[main] graceful quit timed out; forcing process exit");
      app.exit(0);
    }, FORCED_QUIT_TIMEOUT_MS);
    forcedQuitTimer.unref();
  }
  // A second instance can lose the single-instance lock and call app.quit()
  // before Electron reaches ready. globalShortcut is unavailable that early,
  // so only touch it after app.whenReady() has resolved.
  if (app.isReady()) {
    globalShortcut.unregisterAll();
  }
  dictationShortcutSignalRuntime.dispose();
  disposeNativeShortcutController();
  ipcBridge?.shutdown();
  tray?.destroy();
  tray = null;
});

app.on("quit", () => {
  if (forcedQuitTimer) {
    clearTimeout(forcedQuitTimer);
    forcedQuitTimer = null;
  }
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

// The one ipcMain handler that ran no sender check. It leaks little on its own
// — a window label — but "every ipcMain handler validates its sender" is the
// property worth holding, not "every handler that returns something sensitive".
ipcMain.handle("window:get-label", (event) => {
  const frameUrl = trustedSenderFrameUrl(event);
  if (!isTrustedRendererOrigin(frameUrl)) {
    console.warn("[security] rejected window:get-label from untrusted sender", {
      url: frameUrl,
    });
    return null;
  }
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

  installRendererPermissionHandlers();

  if (!devServerUrlIsUsable) {
    await protocol.handle(RENDERER_SCHEME, async (request) => {
      try {
        const rendererRoot = path.join(__dirname, "../dist");
        const assetPath = resolveRendererAssetPath(rendererRoot, request.url);
        // Headers, not just the index.html meta tag: a meta CSP is parsed by
        // the document that carries it and covers nothing else the handler
        // serves, and `frame-ancestors` has no effect in a meta tag at all.
        return withRendererSecurityHeaders(
          await net.fetch(pathToFileURL(assetPath).toString()),
        );
      } catch (error) {
        console.error("[renderer] refused packaged asset request", {
          host: RENDERER_HOST,
          url: request.url,
          error,
        });
        return withRendererSecurityHeaders(
          new Response("Not found", {
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        );
      }
    });
  }

  if (devServerUrlIsUsable) {
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
  ipcBridge.onValidateSender(isTrustedRendererOrigin);
  ipcBridge.onLocalCommand(handleLocalCommand);
  configureAutoUpdater(autoUpdater);

  // A sidecar crash mid-recording would otherwise leave the cached phase at
  // "recording" forever: the restarted sidecar boots Idle, every hotkey press
  // resolves to a failing stop_dictation, and the hotkey is wedged. Reset the
  // mirror and tell renderers so their UI resyncs too.
  ipcBridge.onTerminated(() => {
    // Any hold-to-talk session died with the process: drop its watchdog even
    // if the cached phase never left "idle" (start acked, recording event
    // never observed before the crash).
    dictationShortcutSignalRuntime.onPhase("idle");
    if (dictationPhase !== "idle") {
      dictationPhase = "idle";
      broadcastRendererEvent("dictation-state-changed", { phase: "idle" });
      refreshTray();
    }

    // A meeting dies with the process too. Reporting it as "error" rather than
    // "idle" is deliberate: idle would silently reset the UI as though the user
    // had stopped, and the whole point is that they did not. Audio written
    // before the crash survives — the WAV writer checkpoints its header every
    // five seconds — so the message says recovery is possible.
    if (activeMeetingRecordingId) {
      const interruptedRecordingId = activeMeetingRecordingId;
      broadcastRendererEvent("meeting-recording-state-changed", {
        phase: "recoverable",
        recordingId: interruptedRecordingId,
        message:
          "Recording stopped unexpectedly because the audio engine restarted. Audio captured before the interruption was saved.",
      });
      activeMeetingRecordingId = nextActiveMeetingRecordingId(
        activeMeetingRecordingId,
        { phase: "recoverable", recordingId: interruptedRecordingId },
      );
      refreshTray();
    }
  });

  ipcBridge.onEvent((eventName: string, payload: unknown) => {
    if (eventName === "settings-changed" && payload && typeof payload === "object") {
      applyUiSettings(payload as AppSettings);
      // The sidecar emits this after both normal saves and backup restores.
      // Re-read its now-live settings before re-registering so restored global
      // and native hotkeys take effect without a restart or another save.
      void applyElectronGlobalShortcuts("settings-changed");
    }

    if (
      eventName === "meeting-recording-state-changed" &&
      payload &&
      typeof payload === "object" &&
      "phase" in payload
    ) {
      const lifecycle = payload as {
        phase?: unknown;
        recordingId?: unknown;
      };
      if (typeof lifecycle.phase === "string") {
        activeMeetingRecordingId = nextActiveMeetingRecordingId(
          activeMeetingRecordingId,
          {
            phase: lifecycle.phase as MeetingLifecycleEvent["phase"],
            recordingId:
              typeof lifecycle.recordingId === "string"
                ? lifecycle.recordingId
                : null,
          },
        );
      }
    }

    if (
      eventName === "dictation-state-changed" &&
      payload &&
      typeof payload === "object" &&
      "phase" in payload &&
      typeof (payload as { phase?: unknown }).phase === "string"
    ) {
      const nextPhase = (payload as { phase: string }).phase;
      if (dictationShortcutFailureResetTimer) {
        clearTimeout(dictationShortcutFailureResetTimer);
        dictationShortcutFailureResetTimer = null;
      }
      dictationPhase = nextPhase;
      refreshTray();
      const sessionId = (payload as { sessionId?: unknown }).sessionId;
      if (typeof sessionId === "number") {
        dictationSessionId = sessionId;
      }
      // Keep the hold-to-talk watchdog in lockstep with the observed phase:
      // it is cleared as soon as the guarded session leaves "primed"/
      // "recording" through any path (VAD auto-stop, overlay stop, Escape).
      dictationShortcutSignalRuntime.onPhase(dictationPhase);
      if (dictationPhase === "error") {
        scheduleDictationErrorReset();
      }
    }

    if (eventName === "dictation-text-ready") {
      const text = (payload as { text?: unknown } | null)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        // Mirrors the sidecar's own capped list (it stays the source of truth
        // for the re-paste itself; this copy only labels the menu items).
        recentDictationResults = [{ text }, ...recentDictationResults].slice(0, 3);
        refreshTray();
      }
    }

    if (eventName === "dictation-vad-signal") {
      void handleDictationVadSignal(payload).catch((error) => {
        surfaceDictationShortcutFailure("dictation voice activation", error);
      });
    }

    broadcastRendererEvent(eventName, payload);
  });

  ipcBridge.onWindowCommand((command: string, payload: unknown) => {
    if (command === "show-dictation-overlay") {
      if (showDictationOverlayEnabled) {
        showOverlayWindow(getOrCreateOverlayWindow("dictation"));
      }
    } else if (command === "show-recording-overlay") {
      if (showRecordingOverlayEnabled) {
        showOverlayWindow(getOrCreateOverlayWindow("recording"));
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
    if (command === "apply_global_shortcuts_now") {
      void applyElectronGlobalShortcuts(command);
    }
  });

  ipcBridge.start();
  await applyElectronGlobalShortcuts("startup");

  try {
    const settings = (await ipcBridge.invoke("get_settings")) as AppSettings;
    applyUiSettings(settings);
  } catch (error) {
    console.error("[main] Failed to read window ui settings:", error);
  }

  // createMainWindow() runs after the settings read and applies the
  // window-level settings itself, so every creation path gets them.
  mainWindow = createMainWindow();
  loadOverlayPlacements();
  prepareOverlayWindows();
  createTray();
  bootstrapComplete = true;
}

void bootstrap();
