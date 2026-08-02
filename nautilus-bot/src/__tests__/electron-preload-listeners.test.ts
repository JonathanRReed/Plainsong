import { beforeEach, describe, expect, it, vi } from "vitest";

const preloadMocks = vi.hoisted(() => ({
  exposedApi: null as null | {
    on: (event: string, handler: (payload: unknown) => void) => number;
    off: (event: string, subscriptionId: number) => void;
  },
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, api: typeof preloadMocks.exposedApi) => {
      preloadMocks.exposedApi = api;
    }),
  },
  ipcRenderer: {
    invoke: vi.fn(),
    on: preloadMocks.on,
    removeListener: preloadMocks.removeListener,
  },
}));

describe("Electron preload event subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preloadMocks.exposedApi = null;
  });

  it("removes the exact wrapped listener by stable subscription id", async () => {
    vi.resetModules();
    await import("../../electron/preload");
    const api = preloadMocks.exposedApi;
    expect(api).not.toBeNull();

    const handler = vi.fn();
    const subscriptionId = api!.on("recording-status-changed", handler);
    expect(subscriptionId).toEqual(expect.any(Number));

    const wrappedListener = preloadMocks.on.mock.calls[0]?.[1];
    api!.off("recording-status-changed", subscriptionId);

    expect(preloadMocks.removeListener).toHaveBeenCalledWith(
      "sidecar:event:recording-status-changed",
      wrappedListener,
    );
  });
});
