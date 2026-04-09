import { contextBridge, ipcRenderer } from "electron";

type EventHandler = (payload: unknown) => void;
type IpcEventHandler = (_event: Electron.IpcRendererEvent, payload: unknown) => void;

const listenerRegistry = new Map<string, WeakMap<EventHandler, IpcEventHandler>>();

function getWrappedHandler(event: string, handler: EventHandler): IpcEventHandler {
  let eventHandlers = listenerRegistry.get(event);
  if (!eventHandlers) {
    eventHandlers = new WeakMap<EventHandler, IpcEventHandler>();
    listenerRegistry.set(event, eventHandlers);
  }

  const existing = eventHandlers.get(handler);
  if (existing) {
    return existing;
  }

  const wrapped: IpcEventHandler = (_event, payload) => handler(payload);
  eventHandlers.set(handler, wrapped);
  return wrapped;
}

contextBridge.exposeInMainWorld("electronAPI", {
  invoke: (command: string, args?: unknown): Promise<unknown> =>
    ipcRenderer.invoke("sidecar:invoke", command, args),

  on: (event: string, handler: EventHandler): void => {
    ipcRenderer.on(`sidecar:event:${event}`, getWrappedHandler(event, handler));
  },

  off: (event: string, handler: EventHandler): void => {
    ipcRenderer.removeListener(`sidecar:event:${event}`, getWrappedHandler(event, handler));
  },

  getWindowLabel: (): string | null =>
    ipcRenderer.sendSync("window:get-label") as string | null,
});
