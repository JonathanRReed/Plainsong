export type MainViewId =
  | "dashboard"
  | "projects"
  | "recordings"
  | "dictation"
  | "exports"
  | "settings"
  | "setup";

export const OPEN_MAIN_VIEW_EVENT = "nautilus-open-main-view";

export interface OpenMainViewDetail {
  view: MainViewId;
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
