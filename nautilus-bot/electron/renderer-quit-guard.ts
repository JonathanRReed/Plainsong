export const PREPARE_MAIN_RENDERER_QUIT_SCRIPT =
  "Promise.resolve(typeof window.__plainsongPrepareQuit === 'function' ? window.__plainsongPrepareQuit() : true)";

export function trackRendererQuitHealth(events: {
  on(event: "render-process-gone" | "dom-ready", listener: () => void): unknown;
}): () => boolean {
  let processGone = false;
  events.on("render-process-gone", () => { processGone = true; });
  events.on("dom-ready", () => { processGone = false; });
  return () => processGone;
}

/** Keep the backend available while the mounted editor finishes its save. */
export async function prepareMainRendererQuit(
  execute: (script: string) => Promise<unknown>,
  timeoutMs = 5000,
  rendererProcessGone: () => boolean = () => false,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      execute(PREPARE_MAIN_RENDERER_QUIT_SCRIPT),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(rendererProcessGone()), timeoutMs); }),
    ]);
    return result === true;
  } catch {
    // A renderer that has exited cannot save its lost in-memory drafts.
    // Execution failures in a live renderer still veto shutdown.
    return rendererProcessGone();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
