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
export const OPEN_DICTATION_HISTORY_EVENT = "nautilus-open-dictation-history";
export const OPEN_SETTINGS_TAB_EVENT = "nautilus-open-settings-tab";
export const MEETING_START_REQUEST_EVENT = "nautilus-meeting-start-request";

/**
 * The Settings sections, named by what the reader came to do. Order here is
 * not display order; `SETTINGS_SECTIONS` in
 * `src/components/settings/settings-sections.ts` owns that.
 */
export type SettingsSectionId =
  | "general"
  | "dictation"
  | "meetings"
  | "models"
  | "shortcuts"
  | "ai"
  | "privacy"
  | "advanced";

/**
 * Section ids from before the October 2026 reorganization. Callers may still
 * pass them (a branch written against the old layout, a stored deep link);
 * each lands on the section that now holds what it used to open.
 */
type LegacySettingsTabId = "asr" | "security" | "storage" | "updates";

export type SettingsTabId = SettingsSectionId | LegacySettingsTabId;

const LEGACY_SETTINGS_TABS: Record<LegacySettingsTabId, SettingsSectionId> = {
  // Transcription held the microphones; they live in General now.
  asr: "general",
  security: "privacy",
  storage: "privacy",
  updates: "general",
};

/** The row a legacy id was really about, inside the section it now opens. */
const LEGACY_SETTINGS_FOCUS: Partial<Record<SettingsTabId, string>> = {
  asr: "microphone",
  updates: "updates",
  storage: "retention",
};

export function resolveSettingsSection(tab: SettingsTabId): SettingsSectionId {
  return (LEGACY_SETTINGS_TABS as Record<string, SettingsSectionId>)[tab] ?? (tab as SettingsSectionId);
}

/** Where a settings deep link lands: a section, and optionally one row in it. */
export interface SettingsTabRequest {
  tab: SettingsSectionId;
  /** A row's settings id (`setting-<id>` in the DOM), scrolled to and focused. */
  focus?: string;
}

export type ReadinessDestination =
  | "setup"
  | "models"
  | "transcription"
  | "meetings"
  | "ai";

interface OpenMainViewDetail {
  view: MainViewId;
}

export interface OpenRecordingWorkspaceDetail {
  recordingId: string;
  /** Transcript position, in seconds, the workspace should open on. */
  focusSegmentTime?: number;
  /** Query the transcript search box should carry into the workspace. */
  highlightQuery?: string;
  /** Exact stored action item to reveal in the source meeting. */
  focusActionItem?: string;
}

type ViewLeaveGuard = () => Promise<boolean>;
const viewLeaveGuards = new Map<MainViewId, Set<ViewLeaveGuard>>();

/** A mounted editor may finish saving, or keep its draft visible on failure. */
export function registerViewLeaveGuard(view: MainViewId, guard: ViewLeaveGuard) {
  const guards = viewLeaveGuards.get(view) ?? new Set<ViewLeaveGuard>();
  guards.add(guard);
  viewLeaveGuards.set(view, guards);
  return () => {
    guards.delete(guard);
    if (guards.size === 0) viewLeaveGuards.delete(view);
  };
}

export async function canLeaveMainView(view: MainViewId): Promise<boolean> {
  for (const guard of [...(viewLeaveGuards.get(view) ?? [])]) {
    try {
      if (!(await guard())) return false;
    } catch (error) {
      console.error("Could not save before leaving the workspace:", error);
      return false;
    }
  }
  return true;
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

let pendingSettingsTab: SettingsTabRequest | null = null;

export function requestSettingsTab(tab: SettingsTabId, focus?: string) {
  if (typeof window === "undefined") {
    return;
  }

  const request: SettingsTabRequest = {
    tab: resolveSettingsSection(tab),
    focus: focus ?? LEGACY_SETTINGS_FOCUS[tab],
  };
  pendingSettingsTab = request;
  requestMainView("settings");
  window.dispatchEvent(
    new CustomEvent<SettingsTabRequest>(OPEN_SETTINGS_TAB_EVENT, {
      detail: request,
    }),
  );
}

export function consumePendingSettingsTab(): SettingsTabRequest | null {
  const pending = pendingSettingsTab;
  pendingSettingsTab = null;
  return pending;
}

export function requestReadinessDestination(
  destination: ReadinessDestination,
) {
  switch (destination) {
    case "setup":
      requestMainView("setup");
      return;
    case "models":
      requestSettingsTab("models");
      return;
    case "ai":
      requestSettingsTab("ai");
      return;
    case "meetings":
      // System audio: the other side of a call.
      requestSettingsTab("meetings", "system-audio");
      return;
    case "transcription":
      // "Choose a microphone" -- the microphone lives in General.
      requestSettingsTab("general", "microphone");
      return;
  }
}

// The meetings view is lazy-loaded, so a request made from another view lands
// before its event listener exists. Park the request here as well as emitting
// it; whichever arrives first — the listener or the view's mount — consumes it.
let pendingRecordingWorkspace: OpenRecordingWorkspaceDetail | null = null;

/** Switch to Meetings and open a meeting at a transcript moment or action item. */
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

// Park exact-result requests while the dictation view is lazy-loading.
let pendingDictationHistoryId: string | null = null;

export function queueDictationHistoryRequest(recordingId: string) {
  const id = recordingId.trim();
  if (!id || typeof window === "undefined") return;
  pendingDictationHistoryId = id;
  window.dispatchEvent(new CustomEvent(OPEN_DICTATION_HISTORY_EVENT));
}

export function consumePendingDictationHistoryRequest(): string | null {
  const id = pendingDictationHistoryId;
  pendingDictationHistoryId = null;
  return id;
}

// "Record a Meeting…" in the menu bar and plainsong://meeting/start switch to
// Meetings and ask it to open the consent sheet. The view is lazy-loaded and
// only mounted while it is showing, so the ask is parked here (by the always
// mounted App) and taken by the view once it mounts or, when it is already
// showing, through the window event.
let pendingMeetingStartRequest = false;

export function queueMeetingStartRequest() {
  if (typeof window === "undefined") return;
  pendingMeetingStartRequest = true;
  window.dispatchEvent(new CustomEvent(MEETING_START_REQUEST_EVENT));
}

/** Whether a start request is waiting. Returns true once and then forgets it. */
export function consumePendingMeetingStartRequest(): boolean {
  const pending = pendingMeetingStartRequest;
  pendingMeetingStartRequest = false;
  return pending;
}
