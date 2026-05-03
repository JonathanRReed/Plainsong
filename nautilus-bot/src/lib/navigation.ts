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
