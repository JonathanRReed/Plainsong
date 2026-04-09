/**
 * Electron IPC compatibility adapter for the renderer.
 *
 * The exported functions preserve the legacy frontend call shape so the UI can
 * talk to the Electron preload bridge without wider call-site churn.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  payload: T;
  id: number;
}

export type EventCallback<T> = (event: Event<T>) => void;

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
        "[electron] window.electronAPI not available — is the preload script loaded?"
      )
    );
  }
  return window.electronAPI.invoke(cmd, args ?? {}) as Promise<T>;
}

// ── listen / once ─────────────────────────────────────────────────────────────

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
  window.electronAPI.on(event, wrapped as (payload: unknown) => void);
  return () => {
    window.electronAPI!.off(event, wrapped as (payload: unknown) => void);
  };
}

/**
 * Listen to a backend event once.
 */
export async function once<T = unknown>(
  event: string,
  handler: EventCallback<T>
): Promise<UnlistenFn> {
  let unlisten: UnlistenFn = () => {};
  const wrapped: EventCallback<T> = (e) => {
    handler(e);
    unlisten();
  };
  unlisten = await listen(event, wrapped);
  return unlisten;
}

// ── emit (frontend → main) ────────────────────────────────────────────────────

/**
 * Emit an event from the renderer to the Electron main process.
 */
export function emit(event: string, payload?: unknown): void {
  window.electronAPI?.invoke("__emit__", { event, payload }).catch(() => {});
}

// ── getCurrentWindow / window label ──────────────────────────────────────────

export interface WebviewWindowHandle {
  label: string;
  setSize(size: LogicalSize): Promise<void>;
  setPosition(pos: { x: number; y: number }): Promise<void>;
  hide(): Promise<void>;
  show(): Promise<void>;
  startDragging(): Promise<void>;
}

/**
 * Return the current renderer window handle.
 */
export function getCurrentWindow(): WebviewWindowHandle {
  const label = window.electronAPI?.getWindowLabel() ?? "main";
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
      invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
      on(event: string, handler: (payload: unknown) => void): void;
      off(event: string, handler: (payload: unknown) => void): void;
      getWindowLabel(): string | null;
    };
  }
}
