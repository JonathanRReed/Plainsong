import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  Notification,
  protocol,
  screen,
  session,
  Tray,
  type IpcMainInvokeEvent,
} from "electron/main";
import { nativeImage, shell } from "electron/common";
import { execFile, spawn } from "child_process";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "path";
import { pathToFileURL } from "url";
import { autoUpdater, type AppUpdater } from "electron-updater";
import {
  buildNativeHelperBindingTable,
  cycleDictationMode,
  dictationBindingConflictSources,
  electronFallbackDictationBindings,
  registrableDictationBindings,
  resolveDictationBindingBehavior,
  resolveDictationBindings,
  resolveDictationModeOverride,
  routeDictationBindingEvent,
  validateDictationBindings,
  type DictationBinding,
  type DictationBindingIssue,
} from "./dictation-bindings";
import {
  createDictationShortcutSignalRuntime,
  dictationShortcutFailureMessage,
  resolveDictationShortcutBehavior,
  resolveDictationShortcutCapability,
  shouldHandleDictationShortcutSource,
  type DictationShortcutStartOptions,
} from "./dictation-shortcut-controller";
import { IpcBridge } from "./ipc-bridge";
import os from "node:os";
import {
  captureMainProcessConsole,
  diagnosticLogBuffer,
} from "./diagnostic-log-buffer";
import {
  normalizeNativeShortcutEvent,
  normalizeNativeShortcutHelperShortcut,
  resolveNativeHelperConfigApplication,
  synthesizeNativeShortcutRelease,
  trackNativeShortcutDownBindings,
  type NativeShortcutController,
  type NativeShortcutRawEvent,
} from "./native-macos-shortcut";
import { startNativeMacosShortcutController } from "./native-macos-shortcut-runtime";
import { createMacosCalendarRuntime, type MacosCalendarRuntime } from "./macos-calendar-runtime";
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
  updaterFeedOptions,
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
  nextMeetingNotificationMemory,
  notificationForCallDetected,
  notificationForSidecarEvent,
  resolveNotificationSettings,
  type NotificationContext,
  type NotificationSettings,
  type PlainsongNotification,
} from "./notification-policy";
import {
  clampWindowSizeToWorkArea,
  isFiniteWindowNumber,
} from "./window-bounds-policy";
import {
  isRendererUrl,
  playbackTokenFromUrl,
  playbackUrl,
  RENDERER_HOST,
  RENDERER_SCHEME,
  rendererUrl,
  resolveRendererAssetPath,
  withRendererSecurityHeaders,
} from "./renderer-protocol";
import { parsePreparedPlayback, PlaybackTokenMap } from "./playback-tokens";
import { buildPlaybackResponse } from "./playback-range";
import {
  RENDERER_READY_LOG_MESSAGE,
  shouldForwardRendererConsoleMessage,
} from "./renderer-readiness";
import {
  createDictationOverlayWindow,
  createRecordingOverlayWindow,
  rendererAdditionalArguments,
} from "./windows";
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
import {
  DeepLinkRateLimiter,
  LINK_RECORDING_NOTICE,
  LINK_RECORDING_NOTICE_MS,
  deepLinkActionName,
  deepLinkFromArgv,
  deepLinkNeedsRecordingNotice,
  parseDeepLink,
  resolveDictationModeSelection,
  type DeepLinkCommand,
} from "./deep-link-policy";
import {
  CLI_LINK_PATH,
  describeCliToolStatus,
  manualInstallCommand,
  planCliInstall,
  type CliInstallResult,
  type ExistingLinkPath,
} from "./cli-install";

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
      // The playback route answers `<audio>` with Range responses; media
      // elements only stream from a scheme registered as streamable.
      stream: true,
    },
  },
]);

if (isDev) {
  app.commandLine.appendSwitch("no-proxy-server");
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>;localhost;127.0.0.1");
}

let mainWindow: BrowserWindow | null = null;
let ipcBridge: IpcBridge | null = null;

/**
 * Live playback tokens. The sidecar's answer to `prepare_recording_playback`
 * carries a filesystem path; it is kept here and never forwarded, so the
 * renderer only ever holds a token. See playback-tokens.ts.
 */
const playbackTokens = new PlaybackTokenMap();

/**
 * Forget every playback token. `notifySidecar` is false when the sidecar is
 * already gone: its restart sweeps the decrypted temporaries itself, and a
 * release sent to a dead process would only log a rejection.
 */
function releaseAllPlayback(reason: string, notifySidecar: boolean): void {
  const drained = playbackTokens.drain();
  if (drained.length === 0) {
    return;
  }
  console.log(`[playback] releasing ${drained.length} token(s): ${reason}`);
  if (!notifySidecar || !ipcBridge) {
    return;
  }
  for (const { token } of drained) {
    void ipcBridge.invokeSidecar("release_recording_playback", { token }).catch((error) => {
      console.warn("[playback] release failed", { reason, error });
    });
  }
}

function rendererNotFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Answer `plainsong://playback/<token>`. The token must be one this process
 * registered from a successful prepare; the file is streamed for exactly the
 * requested byte window so seeking is a Range request, not a full download.
 */
async function servePlayback(request: Request, token: string): Promise<Response> {
  const entry = playbackTokens.resolve(token);
  if (!entry) {
    console.warn("[playback] refused unknown token");
    return withRendererSecurityHeaders(rendererNotFoundResponse());
  }
  let size: number;
  try {
    const info = await stat(entry.path);
    if (!info.isFile()) {
      throw new Error("playback path is not a regular file");
    }
    size = info.size;
  } catch (error) {
    // The file can vanish under a live token: locking the vault deletes the
    // decrypted temporary before the revoke event reaches this process.
    console.warn("[playback] audio file unavailable", {
      recordingId: entry.recordingId,
      error,
    });
    playbackTokens.release(token);
    return withRendererSecurityHeaders(rendererNotFoundResponse());
  }
  return withRendererSecurityHeaders(
    buildPlaybackResponse({
      method: request.method,
      rangeHeader: request.headers.get("range"),
      size,
      contentType: "audio/wav",
      openStream: (start, end) =>
        Readable.toWeb(createReadStream(entry.path, { start, end })) as ReadableStream<Uint8Array>,
    }),
  );
}
let dictationPhase = "idle";
let dictationShortcutFailureResetTimer: ReturnType<typeof setTimeout> | null = null;
const captureAdmission = new CaptureAdmissionController();
// The containers "Import audio…" offers in the open dialog. Mirrors
// SUPPORTED_IMPORT_EXTENSIONS in rust-sidecar/src/audio_import.rs, which is
// what actually enforces the list — this only shapes the picker.
// .webm is absent on purpose: CoreAudio has no Matroska demuxer, so afconvert
// answers "Couldn't open input file" for every one of them.
const IMPORTABLE_AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "aac", "mp4", "ogg", "flac"];
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
// Mirror of `automation.localToolsEnabled`. Gates every `plainsong://` deep
// link; the CLI/MCP read the same switch from settings.json themselves.
let localToolsEnabled = false;
let isQuitting = false;
let forcedQuitTimer: ReturnType<typeof setTimeout> | null = null;
const FORCED_QUIT_TIMEOUT_MS = 5_000;
const DICTATION_SHORTCUT_FAILURE_VISIBLE_MS = 8_000;
let nativeShortcutController: NativeShortcutController | null = null;
let nativeShortcutAvailable = false;
let appliedNativeShortcutConfig: string | null = null;
// Bindings the helper reported down and has not reported up. A helper
// restart owes each of these a synthetic release, otherwise a hold that was
// in progress never stops and the session runs to the watchdog.
let nativeShortcutDownBindings: ReadonlySet<string> = new Set<string>();
// A helper table that could not be applied because a session (or a held
// binding) was live. Applied on the next idle; see
// `resolveNativeHelperConfigApplication`.
let pendingNativeShortcutSettings: AppSettings | null = null;
// Latest settings snapshot the shortcut handlers should act on. The native
// helper survives settings saves that don't change its shortcut, so its
// onEvent closure must not act on the settings captured at spawn time.
let latestShortcutSettings: AppSettings = {};
let shortcutConflicts: ShortcutConflictInfo[] = [];
// Per-binding problems from the last registration pass (a mouse button with
// no helper, two bindings on one trigger, ...). Mirrored to the Settings
// screen alongside the helper availability flag.
let dictationBindingIssues: DictationBindingIssue[] = [];
// Mirrors the sidecar's recent-result list so the menu-bar menu can offer
// "Paste" for each without an async round trip while the menu is being built.
let recentDictationResults: Array<{ text: string }> = [];
let dictationPermissionSummary: string | null = null;
// OS notifications. The policy that decides what to say is pure
// (notification-policy.ts); this is the memory it needs between events and
// the settings it is gated on.
let notificationSettings: NotificationSettings = resolveNotificationSettings(null);
let notificationMemory: Pick<
  NotificationContext,
  "previousMeetingPhase" | "previousMeetingRecordingId" | "lastAutoStoppedRecordingId"
> = {
  previousMeetingPhase: null,
  previousMeetingRecordingId: null,
  lastAutoStoppedRecordingId: null,
};
// The same news must reach the reader once, whichever sidecar event carried
// it first. Bounded, oldest first.
const recentNotificationKeys: string[] = [];
const RECENT_NOTIFICATION_KEYS_MAX = 32;
// Notifications currently on screen. A shown `Notification` has no other owner
// in this process, and a collected one takes its click handler with it — so a
// banner the reader comes back to minutes later would do nothing. Emptied as
// each one is clicked, closed or fails.
const liveNotifications = new Set<Notification>();

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
    dictationBindings?: DictationBinding[];
  };
  transcription?: {
    dictationPushToTalk?: boolean;
    dictationHandsFreeEnabled?: boolean;
    dictationModePreset?: string;
    dictationSelectedCustomModeId?: string | null;
    dictationCustomModes?: Array<{ id: string; name: string }>;
  };
  ui?: {
    minimizeToTray?: boolean;
    alwaysOnTop?: boolean;
    showDictationPopup?: boolean;
    showRecordingPopup?: boolean;
  };
  notifications?: {
    meetingEvents?: boolean;
    dictationFailures?: boolean;
  };
  automation?: {
    localToolsEnabled?: boolean;
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

// `did-finish-load` fires before React has mounted and subscribed, so a
// window that was still loading gets the event once on load and once a beat
// later. The popup's handlers are idempotent (the same label re-sets the same
// state), so a duplicate costs nothing and a miss costs the whole notice.
const OVERLAY_EVENT_SETTLE_MS = 200;

/**
 * Deliver an event again to a window that was still loading when it was
 * first broadcast. Only for that case -- an already-loaded window has its
 * listeners and needs no duplicate.
 */
function resendOverlayEventWhenReady(
  window: BrowserWindow,
  eventName: string,
  payload: unknown,
): void {
  const send = () => {
    if (!window.isDestroyed()) {
      window.webContents.send(`sidecar:event:${eventName}`, payload);
    }
  };
  window.webContents.once("did-finish-load", () => {
    send();
    setTimeout(send, OVERLAY_EVENT_SETTLE_MS);
  });
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
  // Set AFTER `channel`: electron-updater's channel setter also sets
  // allowDowngrade to true.
  autoUpdater.allowDowngrade = allowUpdaterDowngrade(channel);
  // The packaged app-update.yml can only name one feed, and it names the beta
  // one. Point the updater at the directory for the channel actually in effect
  // so a stable install never reads a manifest out of the beta bucket.
  autoUpdater.setFeedURL(updaterFeedOptions(channel));

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
  notificationSettings = resolveNotificationSettings(settings);
  localToolsEnabled = settings?.automation?.localToolsEnabled === true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(alwaysOnTopEnabled);
  }
}

function dictationOverlayIsVisible(): boolean {
  if (!showDictationOverlayEnabled) {
    return false;
  }
  const overlay = findWindowByLabel("dictation-overlay");
  return Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible());
}

function mainWindowIsFocused(): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
}

/**
 * Show one notification and route its click.
 *
 * The first notification an install ever shows is what makes macOS ask the
 * reader whether Plainsong may notify at all; nothing here asks ahead of
 * time. A click brings the main window up and asks the renderer for the view
 * the news is about — the same `main-view-requested` channel the tray uses —
 * or, for a detected call, hands the renderer the prefill for the consent
 * dialog.
 */
function presentNotification(notification: PlainsongNotification): void {
  if (recentNotificationKeys.includes(notification.dedupeKey)) {
    return;
  }
  recentNotificationKeys.push(notification.dedupeKey);
  if (recentNotificationKeys.length > RECENT_NOTIFICATION_KEYS_MAX) {
    recentNotificationKeys.shift();
  }
  if (!Notification.isSupported()) {
    return;
  }
  try {
    const note = new Notification({
      title: notification.title,
      body: notification.body,
    });
    // Held until the banner is done with. Nothing else in the main process
    // refers to a shown notification, so without this the object — and the
    // click handler that is the whole point of a "Zoom call started" banner —
    // is eligible for collection the moment `presentNotification` returns.
    liveNotifications.add(note);
    const release = () => {
      liveNotifications.delete(note);
    };
    note.on("click", () => {
      showAndFocusMainWindow();
      const focus = notification.focus;
      if (focus.view === "recordings" && focus.callCapture) {
        broadcastRendererEvent("meeting-call-capture-requested", focus.callCapture);
        release();
        return;
      }
      broadcastRendererEvent("main-view-requested", {
        view: focus.view,
        recordingId: focus.view === "recordings" ? focus.recordingId : null,
      });
      release();
    });
    note.on("close", release);
    note.on("failed", release);
    note.show();
  } catch (error) {
    console.warn("[main] could not show a notification", error);
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

/**
 * A file name a reader can recognise a week later, with no account name in it.
 */
function supportBundleFileName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `plainsong-support-bundle-${stamp}.zip`;
}

/** Hardware and OS facts, none of which name the reader. */
function supportBundleHost(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    logicalCpus: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  };
}

/**
 * What this build can prove about itself.
 *
 * Not a signed release receipt -- Plainsong does not ship one into the app
 * bundle yet -- so this says only what the running process knows: its version,
 * the runtimes under it, and whether it is a packaged app at all.
 */
function supportBundleBuildIdentity(): Record<string, unknown> {
  return {
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node ?? null,
    note: "Plainsong does not embed a signed release receipt in the app bundle; these are the versions the running process reports.",
  };
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
    case "capture_selected_text_for_playback": {
      if (!senderWindow || senderWindow !== mainWindow || !senderWindow.isFocused()) {
        throw new Error(
          "Selected text playback requires the focused main Plainsong window",
        );
      }
      if (!ipcBridge) {
        throw new Error("Selected text playback service is not ready");
      }
      const route = event.senderFrame?.url ?? senderWindow.webContents.getURL();
      const grant = captureAdmission.consume(senderWindow.id, route);
      await ipcBridge.invoke("register_capture_admission", { nonce: grant.nonce });
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar("capture_selected_text_for_playback", {
          admissionNonce: grant.nonce,
        }),
      };
    }
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
        result: { nativeShortcutAvailable, bindingIssues: dictationBindingIssues },
      };
    case "get_shortcut_conflicts":
      return {
        handled: true,
        result: { conflicts: shortcutConflicts },
      };
    case "get_calendar_snapshot": {
      // Reads the stored TCC answer and, only if it is already "authorized",
      // the events. It cannot prompt — see macos-calendar-runtime.ts — so it is
      // safe for the Meetings view to call on mount, which is what lets the
      // "Connect your calendar" card know it has something to offer.
      const payload = (args ?? {}) as { forceRefresh?: unknown };
      return {
        handled: true,
        result: await getMacosCalendarRuntime().readSnapshot({
          forceRefresh: payload.forceRefresh === true,
        }),
      };
    }
    case "request_calendar_access": {
      // The one path that can raise the macOS calendar prompt, so it is gated
      // the same way the folder pickers are: it must come from the main window
      // and it consumes a real user gesture. Calendar access is additive
      // convenience; asking for it unprompted at launch is exactly the
      // behaviour this feature was scoped to avoid.
      requireMainWindowGesture("Connecting your calendar");
      return {
        handled: true,
        result: await getMacosCalendarRuntime().requestAccess(),
      };
    }
    case "open_calendar_privacy_settings": {
      // Deliberately not routed through the sidecar's open_permission_settings:
      // that helper falls back to the Accessibility pane for a section it does
      // not know, and sending someone looking for the Calendars switch to the
      // Accessibility list is worse than offering no button at all.
      //
      // Gated like the dialogs above it, and for the same reason. This does not
      // open a modal, but it does yank System Settings to the foreground, and
      // an ungated version could be driven from a hidden overlay to do that
      // repeatedly — the unprompted-native-surface failure Wave 1 closed for
      // the folder pickers. It is also the only direct `shell.openExternal`
      // call outside the vetted https egress path (external-url-policy.ts), so
      // it needs to be provably reachable by a person and nothing else.
      requireMainWindowGesture("Opening calendar privacy settings");
      if (process.platform !== "darwin") {
        return { handled: true, result: false };
      }
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
      );
      return { handled: true, result: true };
    }
    case "get_cli_tool_status":
      return { handled: true, result: currentCliToolStatus() };
    case "install_cli_tool": {
      // Writes outside the app's own data: a real click in the main window,
      // consumed before anything touches /usr/local/bin.
      requireMainWindowGesture("Installing the command-line tool");
      return { handled: true, result: installCliTool() };
    }
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
    case "select_audio_file_to_import": {
      // The renderer never names a path. It asks for the picker; the path the
      // user chooses goes straight from this handler to the sidecar, so a
      // compromised renderer cannot hand the sidecar a file of its choosing.
      const parent = requireMainWindowGesture("Importing an audio file");
      if (!ipcBridge) {
        throw new Error("Audio import service is not ready");
      }
      const selection = await dialog.showOpenDialog(parent, {
        title: "Choose an audio file to transcribe",
        buttonLabel: "Import audio",
        properties: ["openFile"],
        filters: [
          {
            name: "Audio and video",
            extensions: IMPORTABLE_AUDIO_EXTENSIONS,
          },
        ],
      });
      const selectedPath = selection.canceled ? null : (selection.filePaths[0] ?? null);
      if (!selectedPath) {
        return { handled: true, result: null };
      }
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar("import_audio_file", {
          path: selectedPath,
        }),
      };
    }
    case "preview_support_bundle": {
      // Read-only: says what a bundle would contain and how it would be
      // redacted, so the reader decides before a file exists. No gesture is
      // required because nothing is written and no dialog is opened.
      if (!ipcBridge) {
        throw new Error("Diagnostics service is not ready");
      }
      const description = (await ipcBridge.invokeSidecar(
        "describe_support_bundle",
        {},
      )) as Record<string, unknown>;
      return {
        handled: true,
        result: {
          ...description,
          logLineCount: diagnosticLogBuffer.size,
          suggestedFileName: supportBundleFileName(),
        },
      };
    }
    case "create_support_bundle": {
      // Gated like every other native modal in this handler, and for the same
      // reason. The renderer never names the path: it asks for the picker, and
      // the path the reader chooses goes from here straight to the sidecar.
      const parent = requireMainWindowGesture("Creating a support bundle");
      if (!ipcBridge) {
        throw new Error("Diagnostics service is not ready");
      }
      const selection = await dialog.showSaveDialog(parent, {
        title: "Save the support bundle",
        buttonLabel: "Save bundle",
        defaultPath: path.join(app.getPath("desktop"), supportBundleFileName()),
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      const targetPath = selection.canceled ? null : (selection.filePath ?? null);
      if (!targetPath) {
        return { handled: true, result: null };
      }
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar("write_support_bundle_privileged", {
          targetPath,
          host: supportBundleHost(),
          buildIdentity: supportBundleBuildIdentity(),
          logLines: diagnosticLogBuffer.snapshot(),
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
      // Registering the nonce is what makes the sidecar's admission check
      // real: from the first registered nonce onward it refuses any proof it
      // did not mint here, single-use, within the TTL.
      await ipcBridge.invoke("register_capture_admission", { nonce: grant.nonce });
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
    case "pause_meeting_capture":
    case "resume_meeting_capture": {
      if (!senderWindow) {
        throw new Error("Changing meeting capture requires a Plainsong window");
      }
      if (!ipcBridge) {
        throw new Error("Meeting capture service is not ready");
      }
      const route = event.senderFrame?.url ?? senderWindow.webContents.getURL();
      captureAdmission.consume(senderWindow.id, route);
      if (!activeMeetingRecordingId) {
        throw new Error("There is no active meeting capture");
      }
      const sidecarCommand =
        command === "pause_meeting_capture" ? "pause_recording" : "resume_recording";
      return {
        handled: true,
        result: await ipcBridge.invokeSidecar(sidecarCommand, {
          recordingId: activeMeetingRecordingId,
        }),
      };
    }
    case "prepare_recording_playback": {
      // Main window only: the overlays have no transcript to play against, and
      // a token minted for a hidden window would be a token nobody can see.
      if (!senderWindow || senderWindow !== mainWindow) {
        throw new Error("Playback can only be prepared from the main Plainsong window");
      }
      if (!ipcBridge) {
        throw new Error("Playback service is not ready");
      }
      const payload = (args ?? {}) as { recordingId?: unknown };
      if (typeof payload.recordingId !== "string" || !payload.recordingId) {
        throw new Error("Playback needs a recording id");
      }
      let prepared;
      try {
        prepared = parsePreparedPlayback(
          await ipcBridge.invoke("prepare_recording_playback", {
            recordingId: payload.recordingId,
          }),
        );
      } catch (error) {
        // The sidecar may have registered a token anyway — a five-minute
        // timeout on a long decrypt is the case that happens — and its id
        // never reached anyone who could release it. Ask for the recording's
        // tokens by name so the plaintext is not pinned until the vault locks.
        void ipcBridge
          .invokeSidecar("release_recording_playback", {
            recordingId: payload.recordingId,
          })
          .catch((releaseError) => {
            console.warn("[playback] abandoned prepare not released", releaseError);
          });
        throw error;
      }
      playbackTokens.register(prepared.token, {
        path: prepared.path,
        recordingId: prepared.recordingId,
        protection: prepared.protection,
      });
      // The path stays in this process. The renderer gets the token and the
      // URL the protocol handler answers for it, nothing else.
      return {
        handled: true,
        result: {
          token: prepared.token,
          url: playbackUrl(prepared.token),
          recordingId: prepared.recordingId,
          protection: prepared.protection,
          durationSeconds: prepared.durationSeconds,
        },
      };
    }
    case "release_recording_playback": {
      const payload = (args ?? {}) as { token?: unknown };
      const released = playbackTokens.release(payload.token);
      if (!released || !ipcBridge) {
        return { handled: true, result: { released: false } };
      }
      return {
        handled: true,
        result: await ipcBridge.invoke("release_recording_playback", { token: payload.token }),
      };
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
  getSessionId: () => dictationSessionId,
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
  binding?: DictationBinding,
): Promise<void> {
  if (!ipcBridge) {
    return;
  }

  const settingsBehavior = resolveDictationShortcutBehavior(settings.transcription ?? {});
  // A binding may pin its own activation behavior (hold / toggle); "inherit"
  // and every non-binding signal (Escape, the VAD watchdog) use the setting.
  const behavior =
    binding?.action.kind === "dictation"
      ? resolveDictationBindingBehavior(binding.action.behavior, settingsBehavior)
      : settingsBehavior;
  const capability = resolveDictationShortcutCapability({
    nativeShortcutAvailable,
    behavior,
  });
  // A per-mode binding runs this one session under its mode; the selected
  // mode in Settings is left alone.
  const modeOverride =
    binding?.action.kind === "dictation"
      ? resolveDictationModeOverride(
          binding.action.modeId,
          settings.transcription?.dictationCustomModes ?? [],
        )
      : null;
  const startOptions: DictationShortcutStartOptions | undefined = modeOverride
    ? { modeOverride: { preset: modeOverride.preset, customModeId: modeOverride.customModeId } }
    : undefined;
  await dictationShortcutSignalRuntime.handleSignal({
    behavior,
    capability,
    signal,
    startOptions,
  });
}

/**
 * The mode a `cycleMode` binding lands on is persisted through the sidecar
 * (it is the same setting the Dictation view's profile tiles write), then
 * announced to the popup for a moment so the user knows what the next
 * dictation will run as.
 */
async function handleCycleDictationModeBinding(settings: AppSettings): Promise<void> {
  if (!ipcBridge) {
    return;
  }
  const transcription = settings.transcription ?? {};
  const next = cycleDictationMode(
    {
      modePreset: transcription.dictationModePreset ?? "voice",
      selectedCustomModeId: transcription.dictationSelectedCustomModeId ?? null,
    },
    transcription.dictationCustomModes ?? [],
  );
  const fresh = (await ipcBridge.invoke("get_settings")) as AppSettings & {
    transcription?: Record<string, unknown>;
  };
  const updated = {
    ...fresh,
    transcription: {
      ...(fresh.transcription ?? {}),
      dictationModePreset: next.modePreset,
      dictationSelectedCustomModeId: next.selectedCustomModeId,
    },
  };
  await ipcBridge.invoke("save_settings", { settings: updated });
  qaLog("dictation mode cycled", next);
  // A dictation overlay that had to be created for this notice has not
  // loaded its renderer yet, so a broadcast in the same tick lands before
  // `listen()` has registered anything and is simply dropped -- the notice
  // never appears, on exactly the launch where the user needs it most.
  let freshOverlay: BrowserWindow | null = null;
  if (showDictationOverlayEnabled) {
    const overlay = getOrCreateOverlayWindow("dictation");
    freshOverlay = overlay.webContents.isLoadingMainFrame() ? overlay : null;
    showOverlayWindow(overlay);
  }
  const payload = {
    modePreset: next.modePreset,
    selectedCustomModeId: next.selectedCustomModeId,
    label: next.label,
  };
  broadcastRendererEvent("dictation-mode-cycled", payload);
  if (freshOverlay) {
    resendOverlayEventWhenReady(freshOverlay, "dictation-mode-cycled", payload);
  }
}

async function handleDictationBindingTransition(
  settings: AppSettings,
  binding: DictationBinding,
  event: "down" | "up",
): Promise<void> {
  const route = routeDictationBindingEvent({ binding, event });
  qaLog("dictation binding routed", { bindingId: binding.id, event, route });
  switch (route.kind) {
    case "dictation":
      await handleDictationShortcutSignal(settings, route.signal, binding);
      return;
    case "cycleMode":
      await handleCycleDictationModeBinding(settings);
      return;
    case "cancel":
      await handleDictationShortcutSignal(settings, "cancelled");
      return;
    case "ignore":
      return;
  }
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
    await dictationShortcutSignalRuntime.startHandsFree({ handsFreeTrigger: true });
    return;
  }
}

async function handleDictationGlobalShortcut(
  settings: AppSettings,
  binding: DictationBinding,
): Promise<void> {
  if (!shouldHandleDictationShortcutSource({ source: "electron", nativeShortcutAvailable })) {
    return;
  }
  // Electron only reports presses, so a fallback registration is press-only.
  await handleDictationBindingTransition(settings, binding, "down");
}

async function handleNativeDictationShortcutEvent(
  settings: AppSettings,
  rawEvent: NativeShortcutRawEvent,
): Promise<void> {
  qaLog("dictation native shortcut event", {
    event: rawEvent.event,
    bindingId: rawEvent.bindingId,
    phase: dictationPhase,
    nativeShortcutAvailable,
  });
  if (!shouldHandleDictationShortcutSource({ source: "native", nativeShortcutAvailable })) {
    return;
  }
  // Tracked before any await: a helper restart between here and the release
  // has to know this binding is owed an `up`.
  nativeShortcutDownBindings = trackNativeShortcutDownBindings(
    nativeShortcutDownBindings,
    rawEvent,
  );
  if (rawEvent.event === "up") {
    applyDeferredNativeShortcutConfig("binding released");
  }

  const { signal, bindingId } = normalizeNativeShortcutEvent(rawEvent);
  if (signal === "cancelled") {
    await handleDictationShortcutSignal(settings, "cancelled");
    return;
  }
  const binding = resolveDictationBindings(settings.shortcuts).find(
    (candidate) => candidate.id === bindingId,
  );
  if (!binding) {
    // The helper was spawned with an older table; the next registration pass
    // replaces it. Nothing to act on.
    qaLog("dictation native event for unknown binding", { bindingId });
    return;
  }
  await handleDictationBindingTransition(settings, binding, rawEvent.event);
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

/**
 * Deliver the `up` a helper that is about to die will never send. Runs
 * before the dispose, while `nativeShortcutAvailable` is still true, so the
 * synthetic release takes the same path a real one would and the session
 * stops instead of running to the watchdog.
 */
function releaseHeldNativeShortcutBindings(reason: string): void {
  if (nativeShortcutDownBindings.size === 0) {
    return;
  }
  const releases = synthesizeNativeShortcutRelease(nativeShortcutDownBindings);
  nativeShortcutDownBindings = new Set<string>();
  for (const release of releases) {
    console.warn("[shortcuts] synthesizing release for a held binding", {
      reason,
      bindingId: release.bindingId,
    });
    void handleNativeDictationShortcutEvent(latestShortcutSettings, release).catch((error) => {
      surfaceDictationShortcutFailure("native dictation shortcut", error);
    });
  }
}

/**
 * Apply a helper table that was deferred because a session (or a held
 * binding) was live. Called whenever dictation reaches an idle-ish phase and
 * whenever the last held binding is released.
 */
function applyDeferredNativeShortcutConfig(reason: string): void {
  const pending = pendingNativeShortcutSettings;
  if (!pending) {
    return;
  }
  console.log("[shortcuts] applying deferred native helper table", { reason });
  startNativeShortcutControllerIfNeeded(pending);
}

function startNativeShortcutControllerIfNeeded(settings: AppSettings): void {
  // Every binding the helper can watch goes into its table. Validation here
  // assumes the helper is present (that is what is being started); a mouse or
  // lone-modifier binding is only dropped later, by the Electron fallback,
  // when the helper turns out not to run.
  const bindings = registrableDictationBindings(resolveDictationBindings(settings.shortcuts), {
    nativeShortcutAvailable: true,
    customModes: settings.transcription?.dictationCustomModes ?? [],
  });
  const helperTable = buildNativeHelperBindingTable(
    bindings,
    normalizeNativeShortcutHelperShortcut,
  );
  const desiredConfig = JSON.stringify(helperTable);
  // The helper takes its table on argv, so applying a new one means killing
  // it. Only respawn when the table actually changed (or it died), and never
  // in the middle of a session or a held key: every binding edit in Settings
  // saves immediately, and a SIGTERM landing between `down` and `up` left the
  // release unowed and the session running to the watchdog.
  const decision = resolveNativeHelperConfigApplication({
    desiredConfig,
    appliedConfig: appliedNativeShortcutConfig,
    helperAvailable: Boolean(nativeShortcutController?.status.available),
    dictationPhase,
    bindingsDown: nativeShortcutDownBindings.size,
  });
  if (decision.action === "unchanged") {
    pendingNativeShortcutSettings = null;
    return;
  }
  if (decision.action === "defer") {
    // The running helper keeps delivering the OLD table -- the one the
    // in-flight press came from -- so the release lands on the binding that
    // started the session. Applied on the next idle.
    console.log("[shortcuts] deferring native helper table", { reason: decision.reason });
    pendingNativeShortcutSettings = settings;
    return;
  }
  pendingNativeShortcutSettings = null;

  // Belt and braces for a restart that happens anyway (a helper crash, or a
  // table change while a stale `down` is still tracked): hand the handler the
  // `up` the dying helper will never send.
  releaseHeldNativeShortcutBindings("helper restart");
  disposeNativeShortcutController();

  const controller = startNativeMacosShortcutController({
    platform: process.platform,
    helperPath: getNativeShortcutHelperPath(),
    helperBindings: helperTable,
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

  // The dictation binding table (B4). Issues are computed against the helper
  // that actually came up, so a mouse-button binding on a machine without
  // Accessibility reads "needs the native helper" in Settings instead of
  // silently doing nothing.
  const allBindings = resolveDictationBindings(settings.shortcuts);
  const bindingContext = {
    nativeShortcutAvailable,
    customModes: settings.transcription?.dictationCustomModes ?? [],
  };
  dictationBindingIssues = validateDictationBindings(allBindings, bindingContext);
  for (const issue of dictationBindingIssues) {
    console.warn("[shortcuts] dictation binding skipped", { reason, ...issue });
  }
  broadcastRendererEvent("dictation-shortcut-capability-changed", {
    nativeShortcutAvailable,
    bindingIssues: dictationBindingIssues,
  });
  const registrableBindings = registrableDictationBindings(allBindings, bindingContext);

  // Conflicts are computed against the bindings that will actually be
  // registered, not just the four legacy shortcut fields. The registration
  // loop below takes the bindings first, so a binding on Open window's keys
  // silently won and left nothing but a `console.error`; now Settings shows
  // Open window losing, and names the binding it lost to.
  const conflicts = findConflictingShortcuts(
    settings.shortcuts ?? {},
    dictationBindingConflictSources(registrableBindings, bindingContext.customModes),
  );
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

  // Electron's globalShortcut stands in for key bindings when the helper is
  // not delivering (press-only, so hold degrades to toggle exactly as
  // before). These are registered whether or not the helper is up, as they
  // always were: `shouldHandleDictationShortcutSource` ignores the Electron
  // press while the helper is delivering, so a helper that dies mid-session
  // leaves a working hotkey behind instead of nothing until the next restart.
  // Mouse buttons and lone modifiers have no Electron equivalent and are
  // filtered out by `electronFallbackDictationBindings`. No conflict filter
  // is applied to them: the bindings are first in the precedence list above,
  // so dictation always wins its keys and it is the other field that gets
  // skipped -- which is the documented rule ("Dictation is the app's primary
  // interaction").
  const fallbackBindings = electronFallbackDictationBindings(registrableBindings);
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

  for (const { binding, accelerator } of fallbackBindings) {
    const registered = globalShortcut.register(accelerator, () => {
      void handleDictationGlobalShortcut(latestShortcutSettings, binding).catch((error) => {
        surfaceDictationShortcutFailure("dictation shortcut", error);
      });
    });

    if (!registered) {
      console.error("[shortcuts] failed to register dictation shortcut", {
        reason,
        bindingId: binding.id,
        accelerator,
      });
    } else {
      console.log("[shortcuts] registered dictation shortcut", {
        reason,
        bindingId: binding.id,
        accelerator,
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

function getNativeCalendarHelperPath(): string {
  const binaryName = "plainsong-native-calendar-helper";

  if (isDev) {
    return path.join(__dirname, "../dist-native", binaryName);
  }

  return path.join(process.resourcesPath, "calendar-helper", binaryName);
}

/**
 * Lazily built so the helper path is resolved once, and so a build with no
 * calendar helper (or a non-macOS build) answers "unavailable" rather than
 * throwing at import time.
 *
 * Nothing constructs this during bootstrap. It comes into existence the first
 * time the renderer asks about the calendar, which is itself only after the
 * Meetings view is on screen.
 */
let macosCalendarRuntime: MacosCalendarRuntime | null = null;

function getMacosCalendarRuntime(): MacosCalendarRuntime {
  if (!macosCalendarRuntime) {
    macosCalendarRuntime = createMacosCalendarRuntime({
      platform: process.platform,
      helperPath: getNativeCalendarHelperPath(),
    });
  }
  return macosCalendarRuntime;
}

function getCliBinaryName(): string {
  return process.platform === "win32" ? "plainsong-cli.exe" : "plainsong-cli";
}

/** The `plainsong` command-line tool ships beside the sidecar. */
function getCliBinaryPath(): string {
  const binaryName = getCliBinaryName();
  if (isDev) {
    const debugPath = path.join(__dirname, "../rust-sidecar/target/debug", binaryName);
    if (existsSync(debugPath)) {
      return debugPath;
    }
    return path.join(__dirname, "../rust-sidecar/target/release", binaryName);
  }
  return path.join(process.resourcesPath, "sidecar", binaryName);
}

function inspectCliLinkPath(): ExistingLinkPath {
  try {
    const stat = lstatSync(CLI_LINK_PATH);
    if (stat.isSymbolicLink()) {
      return { kind: "symlink", target: readlinkSync(CLI_LINK_PATH) };
    }
    return stat.isDirectory() ? { kind: "directory" } : { kind: "file" };
  } catch {
    return null;
  }
}

function currentCliToolStatus() {
  const binaryPath = getCliBinaryPath();
  return describeCliToolStatus({
    binaryPath,
    binaryExists: existsSync(binaryPath),
    existing: inspectCliLinkPath(),
  });
}

/**
 * Symlink `/usr/local/bin/plainsong` at the packaged CLI. No privilege
 * escalation: when the directory is not writable (root-owned on a stock
 * macOS) the answer is the one-line command for the user to run, not an
 * admin-password prompt carrying Plainsong's name (see cli-install.ts).
 */
function installCliTool(): CliInstallResult {
  const binaryPath = getCliBinaryPath();
  const plan = planCliInstall({
    platform: process.platform,
    binaryPath,
    binaryExists: existsSync(binaryPath),
    existing: inspectCliLinkPath(),
  });
  switch (plan.action) {
    case "already_installed":
      return { status: "installed", linkPath: CLI_LINK_PATH };
    case "refuse":
      if (plan.reason === "path_occupied") {
        return {
          status: "unavailable",
          reason: `${CLI_LINK_PATH} already exists and is not a Plainsong link, so it was left alone.`,
        };
      }
      if (plan.reason === "binary_missing") {
        return {
          status: "unavailable",
          reason: "The command-line tool is not part of this build.",
        };
      }
      return { status: "unavailable", reason: "The command-line tool installs on macOS and Linux only." };
    case "link":
    case "replace_link": {
      // Never unlink-then-symlink. That left two problems: a failure between
      // the two steps leaves the machine with no `plainsong` command at all,
      // and the gap between deciding (lstat) and acting (unlink) is a window
      // where the path can become something else. Writing the link under a
      // temporary name in the same directory and renaming it over the old one
      // closes both: rename(2) replaces a symlink atomically and operates on
      // the link itself, never following it.
      const stagingPath = `${CLI_LINK_PATH}.plainsong-install-${process.pid}`;
      try {
        try {
          unlinkSync(stagingPath);
        } catch {
          // Nothing there, which is the normal case.
        }
        symlinkSync(binaryPath, stagingPath);
        try {
          renameSync(stagingPath, CLI_LINK_PATH);
        } catch (error) {
          try {
            unlinkSync(stagingPath);
          } catch {
            // Best effort; the staging name is ours and unused.
          }
          throw error;
        }
        return { status: "installed", linkPath: CLI_LINK_PATH };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const reason =
          code === "EACCES" || code === "EPERM"
            ? `Plainsong cannot write to ${path.dirname(CLI_LINK_PATH)} without administrator rights.`
            : `Plainsong could not create the link (${code ?? "unknown error"}).`;
        return { status: "manual", reason, command: manualInstallCommand(binaryPath) };
      }
    }
  }
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
      additionalArguments: [...rendererAdditionalArguments()],
    },
  });
  configureWindowSecurity(win);

  win.on("closed", () => {
    mainWindow = null;
    releaseAllPlayback("main window closed", true);
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

  // A reload or an in-app navigation replaces the renderer that holds the
  // tokens: it will never release them, and the decrypted audio behind them
  // would stay on disk until the vault locked. Same for a renderer that dies,
  // which is why that release is registered here rather than beside the dev
  // logging it used to sit in.
  win.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) {
      return;
    }
    releaseAllPlayback("renderer navigated", true);
  });
  win.webContents.on("render-process-gone", () => {
    releaseAllPlayback("renderer process gone", true);
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
    ipcBridge.setQuitPending(true);
    void finalizeActiveMeetingBeforeQuit().then((result) => {
      if (result.status === "failed") {
        isQuitting = false;
        ipcBridge?.setQuitPending(false);
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


// ── plainsong:// deep links ─────────────────────────────────────────────────

const deepLinkLimiter = new DeepLinkRateLimiter();
// Links that arrived before the sidecar was up (a URL that launched the app).
const pendingDeepLinks: string[] = [];
const MAX_PENDING_DEEP_LINKS = 4;

function recordAutomationAudit(action: string, outcome: string): void {
  if (!ipcBridge) {
    return;
  }
  ipcBridge
    .invokeSidecar("record_automation_audit_event", { source: "deep_link", action, outcome })
    .catch((error) => {
      console.warn("[deep-link] audit write failed", { action, outcome, error });
    });
}

/**
 * Put the dictation HUD on screen carrying "Recording from a link" for a
 * second. The overlay is shown here rather than waiting for the sidecar's own
 * show command so the notice is up before the microphone is.
 */
function announceLinkStartedRecording(): void {
  if (showDictationOverlayEnabled) {
    showOverlayWindow(getOrCreateOverlayWindow("dictation"));
  }
  broadcastRendererEvent("dictation-source-notice", {
    source: "deep_link",
    message: LINK_RECORDING_NOTICE,
    durationMs: LINK_RECORDING_NOTICE_MS,
  });
}

async function performDeepLink(command: DeepLinkCommand): Promise<string> {
  switch (command.kind) {
    case "open":
      showAndFocusMainWindow();
      return "performed";
    case "record": {
      if (!ipcBridge) {
        return "failed_no_sidecar";
      }
      // The same toggle the menu-bar item performs: a link never chooses a
      // hold-to-talk or hands-free behaviour on the user's behalf.
      const live = isDictationLive();
      if (deepLinkNeedsRecordingNotice(command, live)) {
        // A `plainsong://` link is reachable from any web page, and this is
        // the one command that opens the microphone. Show the HUD with the
        // reason on it before the capture starts, so the microphone never
        // comes on without something on screen saying why.
        announceLinkStartedRecording();
      }
      await ipcBridge.invoke(
        live ? "stop_dictation" : "start_dictation",
        live ? { stopReason: "deep_link" } : {},
      );
      return "performed";
    }
    case "stop": {
      if (!ipcBridge) {
        return "failed_no_sidecar";
      }
      if (!isDictationLive()) {
        return "ignored_not_dictating";
      }
      await ipcBridge.invoke("stop_dictation", { stopReason: "deep_link" });
      return "performed";
    }
    case "mode": {
      if (!ipcBridge) {
        return "failed_no_sidecar";
      }
      const settings = (await ipcBridge.invoke("get_settings")) as AppSettings;
      const resolved = resolveDictationModeSelection(command.key, settings.transcription ?? {});
      if (!resolved) {
        return "ignored_unknown_mode";
      }
      if (!resolved.changed) {
        return "performed";
      }
      await ipcBridge.invoke("save_settings", {
        settings: {
          ...settings,
          transcription: { ...settings.transcription, ...resolved.selection },
        },
      });
      return "performed";
    }
    case "meeting_start":
      // Opens the consent sheet and nothing more; recording starts only when
      // the person clicks Start there, exactly as with the New meeting button.
      showAndFocusMainWindow();
      broadcastRendererEvent("main-view-requested", { view: "recordings" });
      broadcastRendererEvent("meeting-start-requested", {});
      return "performed";
    case "meeting_stop": {
      if (!ipcBridge) {
        return "failed_no_sidecar";
      }
      if (!activeMeetingRecordingId) {
        return "ignored_no_meeting";
      }
      await ipcBridge.invokeSidecar("stop_recording", { recordingId: activeMeetingRecordingId });
      return "performed";
    }
  }
}

/**
 * Act on one `plainsong://` URL. The URL text itself is never logged or
 * written to the audit log — only the parsed action and what became of it.
 */
async function handleDeepLink(rawUrl: string): Promise<void> {
  if (!bootstrapComplete) {
    if (pendingDeepLinks.length < MAX_PENDING_DEEP_LINKS) {
      pendingDeepLinks.push(rawUrl);
    }
    return;
  }
  const parsed = parseDeepLink(rawUrl);
  if (!parsed.ok) {
    console.warn("[deep-link] ignored", { reason: parsed.reason });
    return;
  }
  const action = deepLinkActionName(parsed.command);
  if (!localToolsEnabled) {
    console.warn("[deep-link] refused: Local tools is off in Settings > General", { action });
    recordAutomationAudit(action, "refused_local_tools_off");
    return;
  }
  if (!deepLinkLimiter.admit()) {
    console.warn("[deep-link] dropped: too many links in a short time", { action });
    recordAutomationAudit(action, "rate_limited");
    return;
  }
  let outcome: string;
  try {
    outcome = await performDeepLink(parsed.command);
  } catch (error) {
    console.error("[deep-link] failed", { action, error });
    outcome = "failed";
  }
  console.log("[deep-link]", { action, outcome });
  recordAutomationAudit(action, outcome);
}

function flushPendingDeepLinks(): void {
  for (const url of pendingDeepLinks.splice(0)) {
    void handleDeepLink(url);
  }
}

async function bootstrap() {
  // Mirror this process's own logging into the in-memory tail the support
  // bundle reads. Nothing is written to disk and nothing leaves the Mac;
  // see electron/diagnostic-log-buffer.ts.
  captureMainProcessConsole();
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, argv) => {
    showAndFocusMainWindow();
    // Windows and Linux deliver a protocol launch as a second instance with
    // the URL in argv; macOS delivers `open-url` below instead.
    const url = deepLinkFromArgv(argv);
    if (url) {
      void handleDeepLink(url);
    }
  });

  // Registered before `ready` so a URL that launched the app is caught and
  // queued until the sidecar is up.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });

  await app.whenReady();

  if (app.isPackaged) {
    // Pairs with `protocols:` in electron-builder.yml (CFBundleURLTypes).
    // Packaged-only: in development this would register the bare Electron
    // binary as the handler for every `plainsong://` link on the machine.
    app.setAsDefaultProtocolClient("plainsong");
  }

  installRendererPermissionHandlers();

  // Registered in every mode: the playback route has to exist when the
  // renderer comes from the dev server too, or the in-app player would only
  // work packaged. Bundle assets are still served only when packaged.
  await protocol.handle(RENDERER_SCHEME, async (request) => {
    const playbackToken = playbackTokenFromUrl(request.url);
    if (playbackToken !== null) {
      return servePlayback(request, playbackToken);
    }
    if (devServerUrlIsUsable) {
      return withRendererSecurityHeaders(rendererNotFoundResponse());
    }
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
      return withRendererSecurityHeaders(rendererNotFoundResponse());
    }
  });

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
    // The registry died with the process; its restart sweeps the decrypted
    // temporaries. Tokens minted against it must not resolve any more.
    releaseAllPlayback("sidecar terminated", false);
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
    if (
      eventName === "recording-playback-revoked" &&
      payload &&
      typeof payload === "object"
    ) {
      // Vault locked: the sidecar already deleted the plaintext, so the token
      // must stop resolving here as well. The renderer gets the same event.
      playbackTokens.release((payload as { token?: unknown }).token);
    }

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
      // A helper table held back while this session was live can go in now.
      applyDeferredNativeShortcutConfig(`phase ${nextPhase}`);
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

    // Decide against the memory as it was BEFORE this event, then advance it:
    // "meeting started" is the edge into `recording`, not the state.
    const notification = notificationForSidecarEvent(eventName, payload, {
      settings: notificationSettings,
      mainWindowFocused: mainWindowIsFocused(),
      dictationOverlayVisible: dictationOverlayIsVisible(),
      ...notificationMemory,
    });
    notificationMemory = nextMeetingNotificationMemory(eventName, payload, notificationMemory);
    if (notification) {
      presentNotification(notification);
    }
    if (eventName === "meeting-call-detected") {
      // Never starts anything: the click opens the consent dialog, and the
      // reader decides there. `activeMeetingRecordingId` was already advanced
      // above for this event's ordering, and a meeting in progress has
      // nothing to be offered.
      const offer = notificationForCallDetected(payload, {
        activeMeetingRecordingId,
        mainWindowFocused: mainWindowIsFocused(),
      });
      if (offer) {
        presentNotification(offer);
      }
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
  flushPendingDeepLinks();
}

void bootstrap();
