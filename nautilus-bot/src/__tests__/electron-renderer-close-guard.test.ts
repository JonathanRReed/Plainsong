import { describe, expect, it, vi } from "vitest";
import { createRendererCloseGuard } from "../../electron/renderer-close-guard";

function createWindow() {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
  };
}

function createCloseEvent() {
  return { preventDefault: vi.fn() };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("renderer close guard", () => {
  it("blocks a destructive close while the renderer flush is pending", async () => {
    const win = createWindow();
    let finish!: (allowed: boolean) => void;
    const execute = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const guard = createRendererCloseGuard(win, execute);
    const event = createCloseEvent();

    guard(event, { minimizeToTray: false, isQuitting: false });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(win.close).not.toHaveBeenCalled();
    finish(false);
    await flushPromises();
  });

  it("keeps and focuses the existing window when the renderer flush fails", async () => {
    const win = createWindow();
    const guard = createRendererCloseGuard(win, async () => false);
    const event = createCloseEvent();

    guard(event, { minimizeToTray: false, isQuitting: false });
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.close).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("reissues one approved close after a successful renderer flush", async () => {
    const win = createWindow();
    const execute = vi.fn(async () => true);
    const guard = createRendererCloseGuard(win, execute);
    const firstEvent = createCloseEvent();

    guard(firstEvent, { minimizeToTray: false, isQuitting: false });
    await flushPromises();
    expect(win.close).toHaveBeenCalledOnce();

    const reissuedEvent = createCloseEvent();
    guard(reissuedEvent, { minimizeToTray: false, isQuitting: false });

    expect(reissuedEvent.preventDefault).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("honors a new tray preference and consumes the old close approval", async () => {
    const win = createWindow();
    const execute = vi.fn(async () => true);
    const guard = createRendererCloseGuard(win, execute);
    guard(createCloseEvent(), { minimizeToTray: false, isQuitting: false });
    await flushPromises();
    const reissued = createCloseEvent();
    guard(reissued, { minimizeToTray: true, isQuitting: false });
    expect(reissued.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
    guard(createCloseEvent(), { minimizeToTray: false, isQuitting: false });
    expect(execute).toHaveBeenCalledTimes(2);
    await flushPromises();
  });

  it("does not start duplicate flushes for repeated close attempts", async () => {
    const win = createWindow();
    let finish!: (allowed: boolean) => void;
    const execute = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const guard = createRendererCloseGuard(win, execute);

    guard(createCloseEvent(), { minimizeToTray: false, isQuitting: false });
    guard(createCloseEvent(), { minimizeToTray: false, isQuitting: false });

    expect(execute).toHaveBeenCalledOnce();
    finish(false);
    await flushPromises();
  });

  it("keeps the tray-hide path immediate without flushing the renderer", () => {
    const win = createWindow();
    const execute = vi.fn(async () => true);
    const guard = createRendererCloseGuard(win, execute);
    const event = createCloseEvent();

    guard(event, { minimizeToTray: true, isQuitting: false });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not flush or focus a destroyed window", async () => {
    const win = createWindow();
    win.destroy();
    const execute = vi.fn(async () => true);
    const guard = createRendererCloseGuard(win, execute);

    guard(createCloseEvent(), { minimizeToTray: false, isQuitting: false });
    await flushPromises();

    expect(execute).not.toHaveBeenCalled();
    expect(win.close).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });
});
