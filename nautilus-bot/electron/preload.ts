import { contextBridge, ipcRenderer } from "electron/renderer";

// This preload runs sandboxed, where `require` resolves only Electron's own
// modules — a relative import of ./app-locale would throw at bootstrap and take
// the whole bridge with it. So the prefix and the fallback are repeated here
// rather than imported, and
// src/__tests__/renderer-locale-bridge.test.ts fails if these two literals
// ever drift from electron/app-locale.ts.
const APP_LOCALE_ARGUMENT_PREFIX = "--plainsong-app-locale=";
const FALLBACK_APP_LOCALE = "en-US";

/**
 * The locale the main process resolved from `app.getPreferredSystemLanguages()`
 * and passed in through `webPreferences.additionalArguments`. Read
 * synchronously at bootstrap so the renderer never has to await a formatter.
 */
function appLocaleFromArgv(): string {
  const argv: readonly string[] = process.argv ?? [];
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    const argument = argv[index];
    if (typeof argument !== "string") continue;
    if (!argument.startsWith(APP_LOCALE_ARGUMENT_PREFIX)) continue;
    const value = argument
      .slice(APP_LOCALE_ARGUMENT_PREFIX.length)
      .trim()
      .replace(/_/g, "-");
    try {
      const [canonical] = Intl.getCanonicalLocales(value);
      if (canonical) return canonical;
    } catch {
      // Not a usable tag; fall through to the next candidate.
    }
  }
  return FALLBACK_APP_LOCALE;
}

type EventHandler = (payload: unknown) => void;
type IpcEventHandler = (_event: Electron.IpcRendererEvent, payload: unknown) => void;

let nextSubscriptionId = 0;
const listenerRegistry = new Map<
  number,
  { channel: string; wrapped: IpcEventHandler }
>();

contextBridge.exposeInMainWorld("electronAPI", {
  // A plain string, not a getter: the renderer formats with it on every row of
  // every list, and it cannot change while the app runs.
  appLocale: appLocaleFromArgv(),

  invoke: (command: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("sidecar:invoke", command, args),

  on: (event: string, handler: EventHandler): number => {
    const subscriptionId = ++nextSubscriptionId;
    const channel = `sidecar:event:${event}`;
    const wrapped: IpcEventHandler = (_event, payload) => handler(payload);
    listenerRegistry.set(subscriptionId, { channel, wrapped });
    ipcRenderer.on(channel, wrapped);
    return subscriptionId;
  },

  off: (_event: string, subscriptionId: number): void => {
    const subscription = listenerRegistry.get(subscriptionId);
    if (!subscription) {
      return;
    }
    listenerRegistry.delete(subscriptionId);
    ipcRenderer.removeListener(subscription.channel, subscription.wrapped);
  },

  getWindowLabel: (): Promise<string | null> =>
    ipcRenderer.invoke("window:get-label"),

  reportLaunchMilestone: (name: string, rendererElapsedMs: number): void => {
    ipcRenderer.send("launch:renderer-milestone", { name, rendererElapsedMs });
  },
});
