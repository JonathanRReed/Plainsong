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
