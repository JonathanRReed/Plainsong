import { describe, expect, it, vi } from "vitest";
import { createRendererRecoveryPolicy, sendRendererEvent } from "../../electron/renderer-recovery";

function rendererWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      mainFrame: { detached: false } as { detached: boolean } | null,
      send: vi.fn(),
    },
  };
}

describe("renderer event delivery", () => {
  it("sends to an available renderer", () => {
    const window = rendererWindow();
    expect(sendRendererEvent(window, "sidecar:event:recording", { active: true })).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith("sidecar:event:recording", { active: true });
  });

  it.each(["window", "contents", "detached", "missing"])("skips an unavailable %s", (kind) => {
    const window = rendererWindow();
    if (kind === "window") window.isDestroyed.mockReturnValue(true);
    if (kind === "contents") window.webContents.isDestroyed.mockReturnValue(true);
    if (kind === "detached") window.webContents.mainFrame = { detached: true };
    if (kind === "missing") window.webContents.mainFrame = null;
    expect(sendRendererEvent(window, "event", null)).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("handles a frame disposed during send", () => {
    const window = rendererWindow();
    window.webContents.send.mockImplementation(() => { throw new Error("Render frame was disposed before WebFrameMain could be accessed"); });
    expect(sendRendererEvent(window, "event", null)).toBe(false);
  });

  it("handles disposal while reading the main frame", () => {
    const window = rendererWindow();
    Object.defineProperty(window.webContents, "mainFrame", { get: () => { throw new Error("Object has been destroyed"); } });
    expect(sendRendererEvent(window, "event", null)).toBe(false);
  });

  it("preserves ordinary send errors", () => {
    const window = rendererWindow();
    window.webContents.send.mockImplementation(() => { throw new Error("Payload could not be cloned"); });
    expect(() => sendRendererEvent(window, "event", null)).toThrow("Payload could not be cloned");
  });
});

describe("automatic renderer recovery", () => {
  it.each(["crashed", "killed"])("allows one attempt after %s", (reason) => {
    const allowRecovery = createRendererRecoveryPolicy();
    expect(allowRecovery(reason)).toBe(true);
    expect(allowRecovery(reason)).toBe(false);
    expect(allowRecovery("crashed")).toBe(false);
  });

  it.each(["oom", "integrity-failure", "launch-failed", "clean-exit", "abnormal-exit"])("refuses automatic recovery after %s", (reason) => {
    expect(createRendererRecoveryPolicy()(reason)).toBe(false);
  });
});
