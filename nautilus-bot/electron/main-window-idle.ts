import { prepareMainRendererQuit } from "./renderer-quit-guard";

export const MAIN_WINDOW_IDLE_MS = 2 * 60 * 1000;
const CAN_SUSPEND_SCRIPT =
  "typeof window.__plainsongPrepareQuit === 'function' && typeof window.__plainsongCanSuspend === 'function' && window.__plainsongCanSuspend() === true";

/** A show invalidates every pending check, even if the window is hidden again. */
export function createMainWindowIdleController(options: {
  eligible: () => boolean;
  execute: (script: string) => Promise<unknown>;
  flushRendererDrafts: () => Promise<boolean>;
  destroy: () => void;
  timeoutMs?: number;
}) {
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    revision++;
    clearTimeout(timer);
    timer = undefined;
  };
  const hidden = () => {
    cancel();
    const attempt = revision;
    timer = setTimeout(async () => {
      const current = () => revision === attempt && options.eligible();
      try {
        if (!current()) return;
        // Unlike quit, missing setup hooks and crashed renderers veto suspension.
        const safe = () => prepareMainRendererQuit(() => options.execute(CAN_SUSPEND_SCRIPT));
        if (!(await safe()) || !current()) return;
        if (!(await options.flushRendererDrafts()) || !current()) return;
        if (!(await safe()) || !current()) return;
        options.destroy();
      } catch {
        // A failed flush leaves the only copy of an editor in this window.
      } finally {
        if (revision === attempt) hidden();
      }
    }, options.timeoutMs ?? MAIN_WINDOW_IDLE_MS);
    timer.unref?.();
  };
  return { hidden, cancel };
}
