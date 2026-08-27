export type MainViewId =
  | "dashboard"
  | "projects"
  | "recordings"
  | "dictation"
  | "exports"
  | "settings"
  | "setup";

export const OPEN_MAIN_VIEW_EVENT = "nautilus-open-main-view";
export const OPEN_RECORDING_WORKSPACE_EVENT = "nautilus-open-recording-workspace";
export const OPEN_SETTINGS_TAB_EVENT = "nautilus-open-settings-tab";

export type SettingsTabId =
  | "models"
  | "asr"
  | "general"
  | "security"
  | "storage"
  | "ai"
  | "updates";

export type ReadinessDestination = "setup" | "models" | "transcription" | "ai";

interface OpenMainViewDetail {
  view: MainViewId;
}

export interface OpenRecordingWorkspaceDetail {
  recordingId: string;
  /** Transcript position, in seconds, the workspace should open on. */
  focusSegmentTime?: number;
  /** Query the transcript search box should carry into the workspace. */
  highlightQuery?: string;
}

export function requestMainView(view: MainViewId) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<OpenMainViewDetail>(OPEN_MAIN_VIEW_EVENT, {
      detail: { view },
    })
  );
}

let pendingSettingsTab: SettingsTabId | null = null;

function requestSettingsTab(tab: SettingsTabId) {
  if (typeof window === "undefined") {
    return;
  }

  pendingSettingsTab = tab;
  requestMainView("settings");
  window.dispatchEvent(
    new CustomEvent<{ tab: SettingsTabId }>(OPEN_SETTINGS_TAB_EVENT, {
      detail: { tab },
    }),
  );
}

export function consumePendingSettingsTab(): SettingsTabId | null {
  const pending = pendingSettingsTab;
  pendingSettingsTab = null;
  return pending;
}

export function requestReadinessDestination(
  destination: ReadinessDestination,
) {
  if (destination === "setup") {
    requestMainView("setup");
    return;
  }

  if (destination === "models") {
    requestSettingsTab("models");
    return;
  }

  requestSettingsTab(destination === "ai" ? "ai" : "asr");
}

// The meetings view is lazy-loaded, so a request made from another view lands
// before its event listener exists. Park the request here as well as emitting
// it; whichever arrives first — the listener or the view's mount — consumes it.
let pendingRecordingWorkspace: OpenRecordingWorkspaceDetail | null = null;

/** Switch to Meetings and open one meeting, optionally at a transcript moment. */
export function requestRecordingWorkspace(detail: OpenRecordingWorkspaceDetail) {
  if (typeof window === "undefined") {
    return;
  }

  pendingRecordingWorkspace = detail;
  requestMainView("recordings");
  window.dispatchEvent(
    new CustomEvent<OpenRecordingWorkspaceDetail>(OPEN_RECORDING_WORKSPACE_EVENT, {
      detail,
    })
  );
}

/** Take the parked request, if any. Returns it once and then forgets it. */
export function consumePendingRecordingWorkspace(): OpenRecordingWorkspaceDetail | null {
  const pending = pendingRecordingWorkspace;
  pendingRecordingWorkspace = null;
  return pending;
}
