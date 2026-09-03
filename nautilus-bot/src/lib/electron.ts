/**
 * Electron IPC compatibility adapter for the renderer.
 *
 * The exported functions preserve the legacy frontend call shape so the UI can
 * talk to the Electron preload bridge without wider call-site churn.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

type UnlistenFn = () => void;

interface Event<T> {
  event: string;
  payload: T;
  id: number;
}

type EventCallback<T> = (event: Event<T>) => void;

// ── invoke ────────────────────────────────────────────────────────────────────

/**
 * Invoke a Rust backend command via JSON-RPC over the Electron IPC bridge.
 */
export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (!window.electronAPI) {
    return Promise.reject(
      new Error(
        "[electron] window.electronAPI not available, is the preload script loaded?"
      )
    );
  }
  return window.electronAPI.invoke(cmd, args ?? {}) as Promise<T>;
}

// ── listen ───────────────────────────────────────────────────────────────────

let _listenerId = 0;

/**
 * Listen to a backend event.
 * Returns a Promise that resolves to an unlisten function.
 */
export async function listen<T = unknown>(
  event: string,
  handler: EventCallback<T>
): Promise<UnlistenFn> {
  if (!window.electronAPI) {
    return () => {};
  }
  const id = ++_listenerId;
  const wrapped = (payload: T) => {
    handler({ event, payload, id });
  };
  const subscriptionId = window.electronAPI.on(
    event,
    wrapped as (payload: unknown) => void,
  );
  return () => {
    window.electronAPI!.off(event, subscriptionId);
  };
}

// ── getCurrentWindow / window label ──────────────────────────────────────────

interface WebviewWindowHandle {
  label: string;
  setSize(size: LogicalSize): Promise<void>;
  setPosition(pos: { x: number; y: number }): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  startDragging(): Promise<void>;
}

// Cache the window label asynchronously to avoid blocking the renderer
let cachedWindowLabel: string | null = null;
let labelInitialized = false;

async function initializeWindowLabel(): Promise<void> {
  if (!labelInitialized && window.electronAPI) {
    try {
      cachedWindowLabel = await window.electronAPI.getWindowLabel();
      labelInitialized = true;
    } catch (error) {
      console.error("[electron] Failed to get window label:", error);
      cachedWindowLabel = "main";
      labelInitialized = true;
    }
  }
}

// Initialize the label on module load
void initializeWindowLabel();

/**
 * Return the current renderer window handle.
 * Uses a cached label that's initialized asynchronously.
 */
export function getCurrentWindow(): WebviewWindowHandle {
  const label = cachedWindowLabel ?? "main";
  return {
    label,
    async setSize(size: LogicalSize) {
      await window.electronAPI?.invoke("__window_set_size__", {
        width: size.width,
        height: size.height,
      });
    },
    async setPosition(pos: { x: number; y: number }) {
      await window.electronAPI?.invoke("__window_set_position__", pos);
    },
    async hide() {
      await window.electronAPI?.invoke("__window_hide__", { label });
    },
    async show() {
      await window.electronAPI?.invoke("__window_show__", { label });
    },
    async startDragging() {
      await window.electronAPI?.invoke("__window_start_drag__", { label });
    },
  };
}

// ── LogicalSize ───────────────────────────────────────────────────────────────

/**
 * Logical window dimensions.
 */
export class LogicalSize {
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
}

// ── Global type augmentation ──────────────────────────────────────────────────

declare global {
  interface Window {
    electronAPI?: {
      /**
       * The locale the main process resolved from the Mac's own language
       * preferences, for `src/lib/format-locale.ts`. A value, not a call: the
       * packaged bundle ships one Chromium locale and ICU's default inside it
       * is `en-US` whatever the Mac is set to, so every format site needs this.
       */
      appLocale?: string;
      invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
      on(event: string, handler: (payload: unknown) => void): number;
      off(event: string, subscriptionId: number): void;
      getWindowLabel(): Promise<string | null>;
    };
  }
}
