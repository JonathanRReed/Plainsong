import { contextBridge, ipcRenderer } from "electron";

type EventHandler = (payload: unknown) => void;
type IpcEventHandler = (_event: Electron.IpcRendererEvent, payload: unknown) => void;

let nextSubscriptionId = 0;
const listenerRegistry = new Map<
  number,
  { channel: string; wrapped: IpcEventHandler }
>();

contextBridge.exposeInMainWorld("electronAPI", {
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
});
