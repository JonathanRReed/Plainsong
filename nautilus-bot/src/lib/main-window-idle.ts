import type { MainViewId } from "./navigation";

const VIEW_KEY = "plainsong-main-view";
const idleGuards = new Set<() => boolean>();

export function registerMainWindowIdleGuard(guard: () => boolean) {
  idleGuards.add(guard);
  return () => { idleGuards.delete(guard); };
}

export function restoredMainView(): MainViewId {
  try {
    const view = localStorage.getItem(VIEW_KEY);
    switch (view) {
      case "dashboard": case "dictation": case "exports": case "projects":
      case "recordings": case "settings": case "setup": return view;
    }
  } catch { /* Storage failure keeps the default view. */ }
  return "dictation";
}

export function rememberMainView(view: MainViewId): boolean {
  try {
    localStorage.setItem(VIEW_KEY, view);
    return true;
  } catch { return false; }
}

/** Keep flows with component-owned state mounted until the user leaves them. */
export function mainViewCanSuspend(view: MainViewId, document: Document): boolean {
  if (view !== "dictation" && view !== "dashboard") return false;
  if ([...idleGuards].some((guard) => !guard())) return false;
  if (!document.querySelector(".app-shell") || !document.querySelector("button[aria-current='page']")) return false;
  if (document.querySelector("details[open], [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox'], [contenteditable='true'], [aria-busy='true']")) return false;
  // Hiding a window must not end an editor the user was still working in.
  if (document.activeElement?.matches("textarea, input:not([type=button]):not([type=checkbox]):not([type=radio]), [contenteditable]")) return false;
  if ([...document.querySelectorAll("audio, video")].some((media) => media instanceof HTMLMediaElement && !media.paused)) return false;
  return true;
}
